// src/footer.js
// Self-injecting floating footer for authenticated portals

(function() {
  const isAdmin = window.location.pathname.includes('admin.html');
  const tokenKey = isAdmin ? 'admin_token' : 'volunteer_token';

  // Read configuration flags from the script tag attributes
  const currentScript = document.currentScript;
  const includeWhatsApp = currentScript ? currentScript.getAttribute('data-include-whatsapp') !== 'false' : true;
  const bypassAuth = currentScript ? currentScript.getAttribute('data-bypass-auth') === 'true' : false;

  function checkAndRenderFooter() {
    const token = localStorage.getItem(tokenKey);
    let footer = document.getElementById('floating-footer');

    // If not logged in and auth is not bypassed, hide footer and restore padding
    if (!token && !bypassAuth) {
      if (footer) footer.style.display = 'none';
      document.body.style.paddingBottom = '0px';
      return;
    }

    // If footer already exists, show it and return
    if (footer) {
      footer.style.display = 'flex';
      document.body.style.paddingBottom = '60px';
      return;
    }

    // Create footer element
    footer = document.createElement('div');
    footer.id = 'floating-footer';

    // Style footer (glassmorphism look matching app aesthetics)
    Object.assign(footer.style, {
      position: 'fixed',
      bottom: '0',
      left: '0',
      right: '0',
      backgroundColor: 'rgba(252, 251, 249, 0.95)',
      backdropFilter: 'blur(8px)',
      webkitBackdropFilter: 'blur(8px)',
      borderTop: '1px solid #e8e1d3',
      color: '#756c5a',
      padding: '12px 24px',
      fontSize: '11px',
      fontWeight: '500',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      zIndex: '9999',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      boxShadow: '0 -2px 10px rgba(140, 115, 76, 0.06)',
      transition: 'all 0.20s ease'
    });

    // Make it mobile responsive via media query listener
    const mediaQuery = window.matchMedia('(max-width: 600px)');
    function handleMobileChange(e) {
      if (e.matches) {
        footer.style.flexDirection = 'column';
        footer.style.gap = '6px';
        footer.style.textAlign = 'center';
        footer.style.padding = '10px 16px';
        document.body.style.paddingBottom = '80px';
      } else {
        footer.style.flexDirection = 'row';
        footer.style.gap = '0';
        footer.style.textAlign = 'left';
        footer.style.padding = '12px 24px';
        document.body.style.paddingBottom = '60px';
      }
    }
    mediaQuery.addListener(handleMobileChange);

    // Left content (Copyright & Git metadata placeholder)
    const leftSpan = document.createElement('span');
    leftSpan.id = 'footer-left-content';
    leftSpan.style.opacity = '0.85';
    leftSpan.textContent = 'Copyright';
    footer.appendChild(leftSpan);

    // Right content (WhatsApp Link - loaded dynamically via authenticated API)
    const rightSpan = document.createElement('span');
    footer.appendChild(rightSpan);

    if (token && includeWhatsApp) {
      fetch('/api/support-link', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
        .then(res => {
          if (!res.ok) throw new Error('Unauthorized');
          return res.json();
        })
        .then(data => {
          if (data.url) {
            rightSpan.innerHTML = `For support WhatsApp group, <a href="${data.url}" target="_blank" style="color: #8c734c; font-weight: 700; text-decoration: none; border-bottom: 1px dotted #8c734c; padding-bottom: 1px; transition: color 0.15s;">click here</a>`;
            const link = rightSpan.querySelector('a');
            link.addEventListener('mouseenter', () => { link.style.color = '#6b5636'; });
            link.addEventListener('mouseleave', () => { link.style.color = '#8c734c'; });
          }
        })
        .catch(() => {
          rightSpan.textContent = '';
        });
    }

    document.body.appendChild(footer);
    
    // Set initial layout padding based on screen size
    handleMobileChange(mediaQuery);

    // Fetch and populate Git metadata
    fetch('/api/git-info')
      .then(res => {
        if (!res.ok) throw new Error('Status not OK');
        return res.json();
      })
      .then(data => {
        if (data.sha && data.sha !== 'unknown') {
          leftSpan.textContent = `Copyright - ${data.sha}--${data.date}`;
        }
      })
      .catch(err => {
        console.warn('Could not load version metadata:', err.message);
      });
  }

  // Initial render check
  checkAndRenderFooter();

  // Periodically check local storage to handle login / logout lifecycle events reactively
  setInterval(checkAndRenderFooter, 1000);
})();
