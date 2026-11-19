(function () {
  'use strict';
  const SUPABASE_URL = 'https://rwcalcmmrhcssjpkacts.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_sJriHLQFth-kYpO5hKU-wQ_p3xwV4GD';
  let client = null;

  function getClient() {
    if (client) return client;
    if (!window.supabase || !window.supabase.createClient) throw new Error('The account service did not load. Refresh and try again.');
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    client.auth.onAuthStateChange(function () {
      setTimeout(refreshPlusStatus, 0);
    });
    return client;
  }

  function publishStatus(data) {
    window.dispatchEvent(new CustomEvent('schrift-score-plus-status', { detail: data || { hasPlus: false } }));
  }

  async function callFunction(name, body) {
    const supabase = getClient();
    const sessionResult = await supabase.auth.getSession();
    const session = sessionResult.data && sessionResult.data.session;
    if (!session) throw new Error('Sign in to your Schrift Score account first.');
    const response = await fetch(SUPABASE_URL + '/functions/v1/' + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The account service returned an error.');
    return data;
  }

  async function refreshPlusStatus() {
    try {
      const supabase = getClient();
      const result = await supabase.auth.getSession();
      if (!result.data.session) {
        publishStatus({ hasPlus: false, status: 'signed_out' });
        return { hasPlus: false, status: 'signed_out' };
      }
      const data = await callFunction('schrift-status', {});
      publishStatus(data);
      return data;
    } catch (error) {
      publishStatus({ hasPlus: false, status: 'unverified' });
      return { hasPlus: false, status: 'unverified', error: error.message };
    }
  }

  async function startCheckout(plan) {
    const supabase = getClient();
    const session = await supabase.auth.getSession();
    if (!session.data.session) {
      window.location.href = '/account.html?next=checkout&plan=' + encodeURIComponent(plan === 'annual' ? 'annual' : 'monthly');
      return;
    }
    const data = await callFunction('schrift-checkout', { plan: plan === 'annual' ? 'annual' : 'monthly' });
    if (!data.url) throw new Error('Stripe did not return a checkout link.');
    window.location.href = data.url;
  }

  async function openPortal() {
    const data = await callFunction('schrift-portal', {});
    if (!data.url) throw new Error('Stripe did not return a subscription-management link.');
    window.location.href = data.url;
  }

  const ready = (async function () {
    getClient();
    await refreshPlusStatus();
  })();

  window.SchriftScoreAuth = {
    ready,
    getClient,
    callFunction,
    refreshPlusStatus,
    startCheckout,
    openPortal
  };
})();