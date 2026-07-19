setTimeout(() => document.querySelector('.intro')?.classList.add('compact'), 1250);
setTimeout(() => { document.querySelector('.intro').style.opacity = '0'; }, 2250);
setTimeout(() => { location.replace(sessionStorage.getItem('ctrl_profile') ? 'dashboard.html' : 'login.html'); }, 2750);
