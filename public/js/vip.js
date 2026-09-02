// VIP 9,99€ Subscription Manager

function openVipCheckoutModal() {
  if (!AUTH.isLoggedIn()) {
    showToast('Connectez-vous ou créez un compte gratuit pour lier votre abonnement VIP.');
    switchTab('profil');
    return;
  }
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
