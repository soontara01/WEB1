// Demo client for the Entra ID (OIDC) sign-in flow. Sign-in is a plain navigation to
// /api/auth/login; the server redirects to Microsoft and back, then to `returnTo`.
const $ = (id) => document.getElementById(id);

const LOGIN_ERRORS = {
  access_denied: 'Sign-in was cancelled.',
  unavailable: 'The sign-in service is unavailable. Please try again later.',
};

const params = new URLSearchParams(location.search);

// SPAs send users here as /?returnTo=/inventory/orders; pass it on (the server validates it).
const returnTo = params.get('returnTo');
if (returnTo) $('login').href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

const error = params.get('loginError');
if (error) $('message').textContent = LOGIN_ERRORS[error] ?? 'Sign-in failed. Please try again.';

function show(user) {
  $('signed-out').hidden = Boolean(user);
  $('profile').hidden = !user;
  if (user) {
    $('profile-name').textContent = user.name;
    $('profile-email').textContent = user.email;
  }
}

$('logout').addEventListener('click', async () => {
  const csrf = await fetch('/api/auth/csrf').then((r) => r.json());
  const res = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf.csrfToken } });
  const { logoutUrl } = await res.json();
  // Also end the Microsoft session, which redirects back to this page.
  location.assign(logoutUrl);
});

const me = await fetch('/api/auth/me');
show(me.ok ? (await me.json()).user : null);
