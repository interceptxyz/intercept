(function () {
  const $ = id => document.getElementById(id);
  const msg = $('auth-msg');
  const say = (t, err) => { msg.textContent = t; msg.classList.toggle('is-err', !!err); };
  const wallet = $('btn-wallet'), emailForm = $('email-form'), codeForm = $('code-form');
  const emailBtn = emailForm.querySelector('[type=submit]'), codeBtn = codeForm.querySelector('[type=submit]');

  function showAuth() {
    document.title = 'Intercept · Sign in';
    document.body.classList.remove('in-console');
    $('ws').hidden = true; $('auth').hidden = false;
  }
  function showWorkspace(s) {
    document.body.classList.add('in-console');
    $('auth').hidden = true; $('ws').hidden = false;
    const go = () => window.ixConsole.start(s);
    window.ixConsole ? go() : addEventListener('ix:console-ready', go, { once: true });
  }

  // Privy island
  let privyReady = false;
  addEventListener('ix:privy-ready', () => {
    privyReady = true;
    wallet.disabled = false; emailBtn.disabled = false;
    if (msg.dataset.loading) { say(''); delete msg.dataset.loading; }
  });
  addEventListener('ix:signed-in', () => { say(''); fetch('/v1/auth/session').then(r => r.json()).then(s => (s && s.user ? showWorkspace(s) : say('Sign-in failed. Try again.', true))); });
  addEventListener('ix:error', e => { codeBtn.disabled = false; say(e.detail.message, true); });
  setTimeout(() => { if (!privyReady) { msg.dataset.loading = '1'; say('Loading sign-in…'); } }, 1200);

  wallet.addEventListener('click', () => { say(''); window.ixPrivy && window.ixPrivy.login(['wallet']); });

  emailForm.addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say('Enter a valid email address.', true); return; }
    emailBtn.disabled = true; say('Sending a code…');
    try {
      await window.ixPrivy.sendCode(email);
      $('sent-to').textContent = email;
      emailForm.hidden = true; codeForm.hidden = false; say('');
      $('code').focus();
    } catch (err) { say('Could not send a code. Try again in a moment.', true); }
    finally { emailBtn.disabled = false; }
  });
  codeForm.addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('code').value.replace(/\D/g, '');
    if (code.length !== 6) { say('Enter the 6-digit code from the email.', true); return; }
    codeBtn.disabled = true; say('Verifying…');
    try { await window.ixPrivy.loginWithCode(code); } catch (err) { codeBtn.disabled = false; say('That code did not work. Check it and try again.', true); }
  });
  $('code-back').addEventListener('click', () => { codeForm.hidden = true; emailForm.hidden = false; $('code').value = ''; say(''); $('email').focus(); });

  $('signout').addEventListener('click', async () => {
    await fetch('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    try { window.ixPrivy && (await window.ixPrivy.logout()); } catch (e) {}
    codeForm.hidden = true; emailForm.hidden = false; codeBtn.disabled = false;
    showAuth();
  });

  fetch('/v1/auth/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => (s && s.user ? showWorkspace(s) : showAuth())).catch(showAuth);
})();
