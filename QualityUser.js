<script>
(function () {
  'use strict';

  // ===== Конфигурация =====
  var METRIKA_COUNTER_ID = 12345678;          // ID счётчика Яндекс Метрики
  var METRIKA_TARGET = 'QualityUser';         // Имя цели (должно совпадать с настройкой в Метрике)
  var MIN_TIME_ON_SITE = 30000;               // Порог времени на сайте, мс

  var DAILY_STORAGE_KEY = 'interested_user_daily_counter';
  var MAX_GOAL_COUNT_PER_DAY = 3;

  // ===== Состояние сессии =====
  var startTime = 0;
  var isUserActive = false;
  var textSelected = false;
  var hasScrolled = false;
  var hasMouseMoved = false;
  var deviceMotionDetected = false;
  var deviceOrientationDetected = false;
  var goalReachedThisSession = false;

  // Флаги подозрительного поведения. Заполняются единожды зарегистрированными
  // listener-ами ниже; isBot() только читает их состояние.
  var suspiciousMouse = false;
  var suspiciousScroll = false;
  var suspiciousRequests = false;

  // ===== localStorage =====
  function supportsLocalStorage() {
    try {
      var k = '__storage_test__';
      localStorage.setItem(k, k);
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function todayKey() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // Возвращает текущий счётчик за сегодня. Если в storage лежит запись от
  // другого дня — считаем, что сегодня цель ещё не срабатывала.
  function getDailyCount() {
    if (!supportsLocalStorage()) return 0;
    var raw = localStorage.getItem(DAILY_STORAGE_KEY);
    if (!raw) return 0;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.date === todayKey() && typeof parsed.count === 'number') {
        return parsed.count;
      }
    } catch (e) {
      // Старый формат (просто число) трактуем как «не сегодня» и сбрасываем.
    }
    return 0;
  }

  function incrementDailyCount() {
    if (!supportsLocalStorage()) return;
    var next = getDailyCount() + 1;
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify({ date: todayKey(), count: next }));
  }

  function isWithinDailyLimit() {
    return getDailyCount() < MAX_GOAL_COUNT_PER_DAY;
  }

  // ===== Детекция ботов =====
  var BOT_UA_PATTERNS = [
    /bot/, /crawl/, /spider/, /slurp/, /yahoo/, /mediapartners/, /adsbot/,
    /bingbot/, /googlebot/, /baiduspider/, /yandexbot/, /sogou/, /exabot/,
    /facebot/, /ia_archiver/
  ];

  function matchesBotUserAgent() {
    var ua = (navigator.userAgent || '').toLowerCase();
    for (var i = 0; i < BOT_UA_PATTERNS.length; i++) {
      if (BOT_UA_PATTERNS[i].test(ua)) return true;
    }
    return false;
  }

  function isHeadless() {
    // navigator.webdriver === true сам по себе уже сигнал автоматизации
    // (CDP/Selenium/Playwright выставляют его). !window.chrome добавлять нельзя:
    // в Firefox/Safari window.chrome не существует и проверка даёт false-positive.
    return /HeadlessChrome/.test(navigator.userAgent || '');
  }

  function isHiddenViewport() {
    // Применяется только к top-level окну: офскрин-iframe и preview-рендеры
    // у партнёров — легитимный сценарий, их трогать не надо. window.top !==
    // window сам по себе не означает бота, поэтому в этом случае возвращаем
    // false и оставляем вердикт другим проверкам.
    if (window.top !== window) return false;
    return window.innerWidth === 0 && window.innerHeight === 0;
  }

  function isBot() {
    // navigator.webdriver выделено отдельным флагом — это самый надёжный
    // программный сигнал автоматизации, доступный без эвристик.
    return matchesBotUserAgent()
      || isHiddenViewport()
      || navigator.webdriver === true
      || isHeadless()
      || suspiciousMouse
      || suspiciousScroll
      || suspiciousRequests;
  }

  // Анализ дисперсии перемещений мыши: слишком «ровные» дельты при близких
  // к нулю средних — признак бота (программный курсор без человеческого
  // дрожания). Требуем И малую дисперсию, И малое среднее: «ровно и почти
  // не двигается». Иначе ровный медленный скролл-через-мышь у живого юзера
  // тоже попадал бы под подозрение.
  function watchMouseVariance() {
    var lastX, lastY;
    var history = [];
    var maxLen = 20;

    window.addEventListener('mousemove', function (event) {
      hasMouseMoved = true;
      if (lastX !== undefined && lastY !== undefined) {
        history.push({
          dx: Math.abs(event.clientX - lastX),
          dy: Math.abs(event.clientY - lastY)
        });
        if (history.length > maxLen) history.shift();

        if (history.length === maxLen) {
          var sumX = 0, sumY = 0;
          for (var i = 0; i < maxLen; i++) { sumX += history[i].dx; sumY += history[i].dy; }
          var avgX = sumX / maxLen;
          var avgY = sumY / maxLen;

          var varX = 0, varY = 0;
          for (var j = 0; j < maxLen; j++) {
            varX += Math.pow(history[j].dx - avgX, 2);
            varY += Math.pow(history[j].dy - avgY, 2);
          }
          varX /= maxLen;
          varY /= maxLen;

          if (varX < 1 && varY < 1 && avgX < 1 && avgY < 1) suspiciousMouse = true;
        }
      }
      lastX = event.clientX;
      lastY = event.clientY;
    }, { passive: true });
  }

  // Аналогично для прокрутки. У человека длинное чтение даёт ровные тики
  // колеса/трекпада с близкими дельтами — поэтому только малой дисперсии
  // мало, требуем И малое среднее (бот «дёргает» страницу мелкими шагами).
  function watchScrollVariance() {
    var lastY;
    var history = [];
    var maxLen = 20;

    window.addEventListener('scroll', function () {
      hasScrolled = true;
      var y = window.scrollY || window.pageYOffset;
      if (lastY !== undefined) {
        history.push(Math.abs(y - lastY));
        if (history.length > maxLen) history.shift();

        if (history.length === maxLen) {
          var sum = 0;
          for (var i = 0; i < maxLen; i++) sum += history[i];
          var avg = sum / maxLen;

          var v = 0;
          for (var j = 0; j < maxLen; j++) v += Math.pow(history[j] - avg, 2);
          v /= maxLen;

          if (v < 1 && avg < 2) suspiciousScroll = true;
        }
      }
      lastY = y;
    }, { passive: true });
  }

  // Аномально высокая частота дискретных пользовательских событий за минуту.
  // Сюда НЕ включаем mousemove: один реальный взмах мышью даёт 30–50 событий
  // за доли секунды, любой живой юзер мгновенно превысил бы лимит. Mousemove
  // анализируется отдельно через дисперсию в watchMouseVariance().
  function watchRequestFrequency() {
    var stamps = [];
    var limit = 600;     // 10 событий/сек устойчиво — это уже не человек
    var window_ms = 60000;

    function tick() {
      var now = Date.now();
      stamps.push(now);
      var cutoff = now - window_ms;
      while (stamps.length && stamps[0] < cutoff) stamps.shift();
      if (stamps.length > limit) suspiciousRequests = true;
    }

    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('keydown', tick);
    window.addEventListener('touchstart', tick, { passive: true });
  }

  // ===== Цель =====
  // goalReachedThisSession — сессионный (in-memory) флаг: при перезагрузке
  // вкладки сбрасывается, при SPA-навигации сохраняется. Жёсткий cap — это
  // дневной счётчик в localStorage.
  function trackInterestedUser() {
    if (goalReachedThisSession) return;
    if (!isUserActive) return;

    var timeOnSite = Date.now() - startTime;

    // Семантика «качественного пользователя»: время на сайте — обязательный
    // минимальный фильтр, плюс хотя бы один признак реальной активности
    // (скролл, движение мыши, выделение текста, вращение/движение устройства).
    // Открыл и забыл вкладку без скролла — не цель.
    var liveSignal = hasScrolled
      || hasMouseMoved
      || textSelected
      || deviceMotionDetected
      || deviceOrientationDetected;
    var engaged = timeOnSite >= MIN_TIME_ON_SITE && liveSignal;

    if (!engaged) return;
    if (isBot()) return;
    if (!isWithinDailyLimit()) return;
    if (typeof window.ym !== 'function') return;

    window.ym(METRIKA_COUNTER_ID, 'reachGoal', METRIKA_TARGET);
    incrementDailyCount();
    goalReachedThisSession = true;
  }

  // ===== Обработчики активности =====
  function handleUserActivity() {
    if (isUserActive) return;
    isUserActive = true;
    startTime = Date.now();
    setTimeout(trackInterestedUser, MIN_TIME_ON_SITE);
  }

  function handleTextSelection() {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.toString().length > 0) {
      textSelected = true;
      trackInterestedUser();
    }
  }

  function handleDeviceMotion() {
    deviceMotionDetected = true;
    trackInterestedUser();
  }

  function handleDeviceOrientation() {
    deviceOrientationDetected = true;
    trackInterestedUser();
  }

  function throttle(fn, wait) {
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last > wait) {
        last = now;
        fn();
      }
    };
  }

  // ===== Регистрация listener-ов =====
  // 'load' специально НЕ включён: иначе startTime ставится в момент загрузки
  // страницы у любого посетителя (включая ботов и фоновые вкладки), и через
  // MIN_TIME_ON_SITE цель отправляется без единого человеческого ввода.
  // Таймер стартует только от реальной интеракции.
  var activityEvents = ['mousemove', 'keydown', 'scroll', 'touchstart'];
  for (var i = 0; i < activityEvents.length; i++) {
    window.addEventListener(activityEvents[i], handleUserActivity, { once: true, passive: true });
  }

  document.addEventListener('selectionchange', handleTextSelection);

  // DeviceMotion/Orientation работают только на мобильных. На iOS 13+ они
  // требуют DeviceMotionEvent.requestPermission() из user gesture, поэтому
  // без явного UI-разрешения флаги не сработают. На десктопах событий нет
  // вовсе. Это вспомогательный сигнал — основной канал срабатывания цели —
  // время на сайте + выделение текста.
  window.addEventListener('devicemotion', throttle(handleDeviceMotion, 1000));
  window.addEventListener('deviceorientation', throttle(handleDeviceOrientation, 1000));

  watchMouseVariance();
  watchScrollVariance();
  watchRequestFrequency();
})();
</script>
