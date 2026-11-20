// VIP 9,99€ Subscription & Ticket Request Manager

function openVipTicketRequest() {
  if (typeof navigateToTab === 'function') {
    navigateToTab('contact');
  } else if (typeof switchTab === 'function') {
    switchTab('contact', true);
  }

  setTimeout(() => {
    const nameInput = document.getElementById('contactName');
    const emailInput = document.getElementById('contactEmail');
    const subjectSelect = document.getElementById('contactSubjectSelect');
    const msgInput = document.getElementById('contactMessage');

    if (typeof AUTH !== 'undefined' && AUTH.user) {
      if (nameInput && !nameInput.value) nameInput.value = AUTH.user.username || '';
      if (emailInput && !emailInput.value) emailInput.value = AUTH.user.email || '';
    }

    const vipSubject = "Demande d'abonnement Club VIP (Modalités de paiement)";
    if (subjectSelect) {
      subjectSelect.value = vipSubject;
      if (typeof handleContactSubjectChange === 'function') {
        handleContactSubjectChange(subjectSelect);
      } else {
        const hiddenSubject = document.getElementById('contactSubject');
        if (hiddenSubject) hiddenSubject.value = vipSubject;
      }
    }

    if (msgInput && !msgInput.value.trim()) {
      const pseudoPart = (typeof AUTH !== 'undefined' && AUTH.user && AUTH.user.username)
        ? ` (compte : ${AUTH.user.username})`
        : '';
      msgInput.value = `Bonjour,\n\nJe souhaite souscrire à l'abonnement Club VIP (9,99€ / mois)${pseudoPart}. Pouvez-vous m'envoyer les modalités de paiement afin d'activer mon accès ?\n\nMerci d'avance.`;
    }

    if (typeof showToast === 'function') {
      showToast('Ticket VIP pré-rempli : envoyez votre requête pour recevoir les modalités de paiement.');
    }

    if (msgInput) {
      msgInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 80);
}
window.openVipTicketRequest = openVipTicketRequest;

async function openVipCheckoutModal() {
  openVipTicketRequest();
}

function closeVipModal(e) {
  if (e && e.target) {
    const isOverlayClick = (e.target === e.currentTarget);
    const isCloseBtnClick = Boolean(e.target.closest && e.target.closest('.modal-close-btn'));
    if (!isOverlayClick && !isCloseBtnClick) {
      return;
    }
  }
  const modal = document.getElementById('vipModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
  }
}
window.closeVipModal = closeVipModal;

// Keyboard Escape closes modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeVipModal();
  }
});

async function processVipSubscription() {
  if (typeof AUTH === 'undefined' || !AUTH.isAdmin()) {
    showToast("L'activation VIP est réservée à l'administrateur pendant la phase de test.");
    return;
  }

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
