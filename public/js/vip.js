// VIP 9,99€ Subscription & Stripe Manager

async function openVipCheckoutModal() {
  if (!AUTH.isLoggedIn()) {
    showToast('Connectez-vous ou créez un compte gratuit pour lier votre abonnement VIP.');
    switchTab('profil');
    return;
  }

  // Attempt Stripe Checkout first if configured
  try {
    const res = await fetch('/api/vip/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      }
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
      return;
    }
  } catch (e) {}

  // Fallback modal
  const display = document.getElementById('cardHolderNameDisplay');
  if (display && AUTH.user && AUTH.user.username) {
    display.textContent = AUTH.user.username.toUpperCase();
  }
  const modal = document.getElementById('vipModal');
  if (modal) modal.classList.remove('hidden');
}

function closeVipModal(e) {
  if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close-btn')) {
    return;
  }
  const modal = document.getElementById('vipModal');
  if (modal) modal.classList.add('hidden');
}

async function processVipSubscription() {
  if (!AUTH.isLoggedIn()) {
    showToast('Vous devez être connecté.');
    return;
  }

  try {
    const res = await fetch('/api/vip/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH.token}`
      },
      body: JSON.stringify({ paymentMethod: 'cb', durationMonths: 1 })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Erreur lors du paiement');
      return;
    }

    // Update current user
    AUTH.user = data.user;
    AUTH.updateUi();

    closeVipModal();
    showToast('Félicitations ! Votre abonnement Membre VIP (9,99€/mois) est activé.');
    
    // Reload videos to refresh VIP badges
    loadVideos();
    switchTab('profil');
  } catch (err) {
    showToast('Erreur de traitement du paiement.');
  }
}

// Check Stripe Return URL params on page load
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const vipStatus = urlParams.get('vip_status');
  const sessionId = urlParams.get('session_id');

  if (vipStatus === 'success' && sessionId && typeof AUTH !== 'undefined' && AUTH.isLoggedIn()) {
    try {
      const res = await fetch('/api/vip/verify-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AUTH.token}`
        },
        body: JSON.stringify({ sessionId })
      });
      const data = await res.json();
      if (res.ok && data.user) {
        AUTH.user = data.user;
        AUTH.updateUi();
        showToast('Paiement validé ! Bienvenue dans le Club VIP (9,99€/mois).');
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (e) {}
  } else if (vipStatus === 'cancelled') {
    showToast('Paiement VIP annulé.');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
});
