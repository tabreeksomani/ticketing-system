# CloudWatch Logging Guide

This guide provides step-by-step instructions to verify, configure, and stream your application logs from the EC2 instance(s) to AWS CloudWatch Logs.

This configuration is fully backward-compatible with all systemd versions (including systemd v219 on Amazon Linux 2).

---

## 1. Verify Current State

Before making changes, verify where logs are currently going and confirm that CloudWatch streaming is not yet active.

### A. Check systemd Logs
Run this command on your EC2 host. Currently, logs are only stored in `journald`:
```bash
sudo journalctl -u mulaqatexpress.service -n 20 --no-pager
```

### B. Confirm No Log File Exists
Verify that there is no custom log file directory:
```bash
ls -la /var/log/mulaqatexpress
```
*Expected Output: `ls: cannot access '/var/log/mulaqatexpress': No such file or directory`*

### C. Confirm CloudWatch Agent Status
Verify if the CloudWatch Agent is already installed or running:
```bash
sudo systemctl status amazon-cloudwatch-agent
```
*Expected Output: `Unit amazon-cloudwatch-agent.service could not be found.` (or status is inactive).*

---

## 2. Apply the Fix

Perform these steps on your EC2 host to redirect logs and configure the CloudWatch Agent.

### Step A: Create the Log Directory Manually
Run these commands to create the folder and grant write permissions to the `ec2-user`:
```bash
sudo mkdir -p /var/log/mulaqatexpress
sudo chown -R ec2-user:ec2-user /var/log/mulaqatexpress
```

### Step B: Update the systemd Service File
1. Open the service configuration file in `vi`:
   ```bash
   sudo vi /etc/systemd/system/mulaqatexpress.service
   ```
2. Comment out the original `ExecStart` line and add the new one that redirects stdout/stderr to our log file:
   ```ini
   # ExecStart=/usr/bin/npm start
   ExecStart=/bin/sh -c '/usr/bin/npm start >> /var/log/mulaqatexpress/app.log 2>&1'
   ```
3. Save and exit `vi` (press `Esc`, then type `:wq` and press `Enter`).

### Step C: Reload and Restart the Service
Reload systemd and restart the service:
```bash
sudo systemctl daemon-reload
sudo systemctl restart mulaqatexpress
```

### Step D: Verify Local Log File Creation
Confirm systemd successfully started the app and is writing logs to the file:
```bash
tail -f /var/log/mulaqatexpress/app.log
```
*Expected Output: You should see the Node.js startup log: `Ticketing system listening on http://localhost:8000` (or port `80` depending on your environment).*

---

## 3. Install & Start the CloudWatch Agent

### Step A: Attach IAM Policy to EC2 (AWS Console)
1. In the **AWS EC2 Console**, navigate to your instances.
2. Select your instance one-by-one. Under **Actions** -> **Security** -> **Modify IAM Role**, attach an IAM Role (Instance Profile) that contains the managed policy **`CloudWatchAgentServerPolicy`**.
*Note: This is required so the agent on the host has AWS credentials to push logs.*

### Step B: Install the CloudWatch Agent
On the EC2 host:
```bash
sudo yum install amazon-cloudwatch-agent -y
```

### Step C: Copy the Configuration File
Copy the agent configuration from the cloned repository:
```bash
sudo cp ~/ticketing-system/aws/amazon-cloudwatch-agent.json /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
```

### Step D: Start & Enable the Agent
```bash
sudo systemctl enable amazon-cloudwatch-agent
sudo systemctl restart amazon-cloudwatch-agent
```

---

## 4. Verify CloudWatch Streaming

Confirm that logs are flowing successfully to AWS.

### A. Check Agent Running Status
Confirm the CloudWatch Agent service is active and running cleanly:
```bash
sudo systemctl status amazon-cloudwatch-agent
```
*Expected Output: `Active: active (running)`*

### B. Trigger a Test Log Event
Generate some traffic to the Express server to produce log lines:
```bash
curl http://localhost:8000/health
```

### C. Verify Directly via Web SSH (Console Bypass)
View the CloudWatch Agent's internal operational logs on the host:
```bash
sudo tail -n 50 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```
* **Success**: You should see lines indicating active publication to CloudWatch:
  `Published 1 datums for mulaqat-express-logs...`
* **Failure/Access Denied**: If the EC2 Instance IAM Role is missing permissions or misconfigured, you will see `AccessDeniedException` or credential errors in this log file.

### D. Verify Logs in AWS Console
1. Log into your **AWS Console** and navigate to **CloudWatch** -> **Logs** -> **Log groups**.
2. Select the log group **`mulaqat-express-logs`**.
3. Under **Log streams**, select the stream named after your instance's hostname.
4. Confirm that your application output logs are visible in the console.
