# Architecture
We're using an ALB with ssl termination, routing to a target group in EC2.
The target group performs health checks via `/` to add/remove instances from the group.
The service is horizontally scalable, and uses RDS (postgres) for its backend state.

### Service Deployment
To scale out the EC2 cluster:
1. launch a new EC2 instance.
Generate a new key-pair - this is our backup to accessing that host.
Security group: launch-wizard-1
2. on the host:
```
$ sudo yum install npm git
$ sudo setcap 'cap_net_bind_service=+ep' /usr/bin/node-18
$ git clone https://github.com/tabreeksomani/ticketing-system.git
$ cd ticketing-system
$ npm install
$ curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```
3. setup the runtime config
```
# ~/ticketing-system/.env
DATABASE_URL=postgres://postgres:<FILL_IN_PASSWORD>@ticketingsystem.c92o0i4myfv9.ca-central-1.rds.amazonaws.com:5432/ticketing_system
JWT_SECRET=<FILL_IN_SECRET>
DATABASE_SSL=true
DATABASE_CA_CERT=./global-bundle.pem
PORT=80
APP_DEBUG=0

# Behavior when server starts with unapplied migrations (WARN, KILL, IGNORE)
DATABASE_MIGRATION_BEHAVIOR=WARN
```

4. Apply Database Migrations (Only needed once per schema release, not for every instance scale-out):
```
$ npm run db:migrate
```

5. setup the service definition
```
# /etc/systemd/system/mulaqatexpress.service
[Unit]
Description=mulaqatexpress
After=network.target

[Service]
ExecStart=/usr/bin/npm start
WorkingDirectory=/home/ec2-user/ticketing-system
Restart=always
User=ec2-user
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
6. finally, run the service
```
$ sudo systemctl daemon-reload
$ sudo systemctl restart mulaqatexpress
$ sudo systemctl status mulaqatexpress
```

### Load Balancer Participation
1. in EC2, go to Target Groups
2. select ours, then open "Register Targets"
3. click the new instance in "Available Instances", and then "Include as pending below", and finally "Register .."
4. the dashboard should now reflect a new "Healthy" instance
