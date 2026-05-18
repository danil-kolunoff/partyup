// Тонкая обёртка над window.Telegram.WebApp, чтобы не плодить try/catch.
export function tg() {
  return typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
}

export function tgUser() {
  return tg()?.initDataUnsafe?.user || null;
}

export function tgInitData() {
  return tg()?.initData || '';
}

export function tgStartParam() {
  return tg()?.initDataUnsafe?.start_param || null;
}

export function haptic(type = 'selection') {
  const t = tg();
  if (!t?.HapticFeedback) return;
  // Юзер выключил вибрацию в настройках — silently no-op.
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem('pu_haptics') === 'off') return; } catch {}
  try {
    if (type === 'success') t.HapticFeedback.notificationOccurred('success');
    else if (type === 'error') t.HapticFeedback.notificationOccurred('error');
    else if (type === 'warning') t.HapticFeedback.notificationOccurred('warning');
    else if (type === 'impact') t.HapticFeedback.impactOccurred('light');
    else if (type === 'impact_medium') t.HapticFeedback.impactOccurred('medium');
    else if (type === 'impact_heavy') t.HapticFeedback.impactOccurred('heavy');
    else if (type === 'impact_soft') t.HapticFeedback.impactOccurred('soft');
    else if (type === 'impact_rigid') t.HapticFeedback.impactOccurred('rigid');
    else t.HapticFeedback.selectionChanged();
  } catch {}
}

// Серия импактов «взрыв», синхронизированная с разлётом эмодзи при смене вайба.
// На iOS даёт ощущение как у Taptic Engine «success+rumble».
export function hapticBurst(intensity = 'normal') {
  const t = tg();
  if (!t?.HapticFeedback) return;
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem('pu_haptics') === 'off') return; } catch {}
  const seq =
    intensity === 'soft'
      ? [['impact', 'soft', 0], ['impact', 'soft', 80], ['impact', 'light', 160]]
      : intensity === 'strong'
      ? [['notification', 'success', 0], ['impact', 'medium', 70],
         ['impact', 'rigid', 140], ['impact', 'light', 220], ['impact', 'soft', 320]]
      : // normal — «весело и заметно», без перебора
        [['notification', 'success', 0], ['impact', 'soft', 90],
         ['impact', 'light', 180], ['impact', 'soft', 300]];
  for (const [kind, arg, delay] of seq) {
    setTimeout(() => {
      try {
        if (kind === 'notification') t.HapticFeedback.notificationOccurred(arg);
        else t.HapticFeedback.impactOccurred(arg);
      } catch {}
    }, delay);
  }
}

// Поделиться текстом+ссылкой в любой TG-чат через нативный share-композер.
export function shareToTelegram(url, text) {
  const t = tg();
  const link = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text || '')}`;
  if (t?.openTelegramLink) t.openTelegramLink(link);
  else window.open(link, '_blank');
}

// Авторизован ли юзер сейчас: либо открыт Mini App (initData), либо есть TG-сессия в cookie.
// Cookie проверяем косвенно через checkSession callback (если передан).
export function isLoggedInTelegram() {
  return !!tgInitData();
}

// Универсальный share с учётом авторизации:
// - если открыто в TG Mini App (или есть signed-in tg user) — нативный share-композер;
// - иначе — копируем URL в буфер обмена + лёгкий toast «Скопировано».
export async function smartShare({ url, text, isAuthorized }) {
  if (isAuthorized) {
    shareToTelegram(url, text);
    return { mode: 'telegram' };
  }
  // Гость: пытаемся в clipboard. Web Share API только с user-gesture, но в этом
  // вызове как раз и есть user click — он сработает.
  try {
    if (navigator?.share) {
      await navigator.share({ url, text });
      return { mode: 'native_share' };
    }
  } catch {/* user cancelled */}
  try {
    await navigator.clipboard.writeText(url);
    return { mode: 'clipboard' };
  } catch {
    // фоллбек: открываем mailto-like share
    window.prompt('Скопируй ссылку:', url);
    return { mode: 'prompt' };
  }
}

// Версия Bot API, поддерживаемая клиентом. У telegram-web-app.js это tg.version (строка "7.10").
function tgVersionAtLeast(target) {
  const v = tg()?.version || '0';
  const a = String(v).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(target).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

// Нативный share-пикер чатов Telegram (Bot API 8.0+). Принимает preparedMessageId,
// сгенерированный сервером через savePreparedInlineMessage. Если не поддерживается —
// падаем обратно на shareToTelegram(url, text).
export function shareMessageById(preparedMessageId, fallback) {
  const t = tg();
  if (t?.shareMessage && tgVersionAtLeast('8.0') && preparedMessageId) {
    try {
      t.shareMessage(preparedMessageId, (ok) => { if (!ok && fallback) fallback(); });
      return true;
    } catch {}
  }
  if (fallback) fallback();
  return false;
}

// Открыть нативный «выбрать чат → вставить» (inline mode). query — что подставится в поле ввода.
export function switchInlineQuery(query = '', chatTypes = ['users', 'groups', 'channels']) {
  const t = tg();
  if (t?.switchInlineQuery && tgVersionAtLeast('6.7')) {
    try { t.switchInlineQuery(query, chatTypes); return true; } catch {}
  }
  return false;
}

// Deeplink на бота или Mini App.
// Если задан appShortName — используем Direct Link Mini App (открывает приложение сразу из чата):
//   https://t.me/<bot>/<app>?startapp=<param>
// Иначе — обычный bot deeplink с ?start=, который запускает /start у бота
// (наш webhook отвечает кнопкой «Играть»):
//   https://t.me/<bot>?start=<param>
export function miniAppLink(botUsername, appShortName, startParam) {
  if (!botUsername) return null;
  if (appShortName) {
    const base = `https://t.me/${botUsername}/${appShortName}`;
    return startParam ? `${base}?startapp=${encodeURIComponent(startParam)}` : base;
  }
  const base = `https://t.me/${botUsername}`;
  return startParam ? `${base}?start=${encodeURIComponent(startParam)}` : base;
}

// Anonymous id для пользователей вне Telegram (web/dev режим).
export function getAnonId() {
  if (typeof window === 'undefined') return null;
  try {
    let id = localStorage.getItem('pu_anon_id');
    if (!id) {
      id = `a_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem('pu_anon_id', id);
    }
    return id;
  } catch { return null; }
}
