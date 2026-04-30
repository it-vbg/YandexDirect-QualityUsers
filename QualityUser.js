<script>
(function () {
  'use strict';

  // ===== Конфигурация =====
  var METRIKA_COUNTER_ID = 12345678;          // ID счётчика Яндекс Метрики
  var METRIKA_TARGET = 'QualityUser';         // Имя цели (должно совпадать с настройкой в Метрике)
  var MIN_TIME_ON_SITE = 30000;               // Минимальное ВИДИМОЕ время на сайте, мс
  var MIN_ACTIVE_TIME = 15000;                // Минимальное АКТИВНОЕ время (без idle), мс
  var IDLE_THRESHOLD = 30000;                 // После сколько мс простоя счётчик активности встаёт на паузу

  var DAILY_STORAGE_KEY = 'interested_user_daily_counter';
  var VISIT_COUNT_KEY = 'interested_user_visit_count';
  var LAST_VISIT_AT_KEY = 'interested_user_last_visit_at';
  var SAME_SESSION_GAP_MS = 30 * 60 * 1000;   // < 30 мин с прошлого визита = тот же визит, не считаем
  var MAX_GOAL_COUNT_PER_DAY = 3;

  // Порог скоринга (0-100) для срабатывания цели. Калибруется по распределению
  // параметра score в Метрике под конкретный сайт.
  var GOAL_SCORE_THRESHOLD = 60;

  // ===== Состояние сессии =====
  var isUserActive = false;
  var textSelected = false;
  var hasScrolled = false;
  var hasMouseMoved = false;
  var deviceMotionDetected = false;
  var deviceOrientationDetected = false;
  var goalReachedThisSession = false;
  var maxScrollDepth = 0;             // Доля прокрученного документа от 0 до 1
  var copied = false;                 // Был ли copy-event (сильный сигнал чтения)

  // Счётчик видимого времени: тикает только пока вкладка в foreground.
  var visibleTimeAccumulated = 0;
  var lastVisibleStart = (typeof document !== 'undefined' && document.visibilityState === 'visible') ? Date.now() : 0;

  // Счётчик активного времени: тикает только пока вкладка видима И последняя
  // активность была не дольше IDLE_THRESHOLD назад.
  var activeTime = 0;
  var lastActivityAt = Date.now();

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

  // Счётчик визитов в этом браузере. Инкремент только если с прошлого визита
  // прошло >= SAME_SESSION_GAP_MS — иначе это рефреш/возврат на ту же страницу,
  // а не «вернувшийся пользователь». Используется как параметр цели.
  function bumpVisitCount() {
    if (!supportsLocalStorage()) return 1;
    var raw = localStorage.getItem(VISIT_COUNT_KEY);
    var n = parseInt(raw, 10);
    if (!(n >= 0)) n = 0;

    var lastAt = parseInt(localStorage.getItem(LAST_VISIT_AT_KEY), 10);
    var now = Date.now();
    var isFreshVisit = !(lastAt > 0) || (now - lastAt >= SAME_SESSION_GAP_MS);

    if (isFreshVisit) {
      n += 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(n));
    } else if (n === 0) {
      n = 1;  // первый замер, но storage пустой
      localStorage.setItem(VISIT_COUNT_KEY, '1');
    }
    localStorage.setItem(LAST_VISIT_AT_KEY, String(now));
    return n;
  }
  var visitCount = bumpVisitCount();

  // ===== Время видимости и активности =====
  function getVisibleTime() {
    return visibleTimeAccumulated + (lastVisibleStart ? Date.now() - lastVisibleStart : 0);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      lastVisibleStart = Date.now();
    } else if (lastVisibleStart) {
      visibleTimeAccumulated += Date.now() - lastVisibleStart;
      lastVisibleStart = 0;
    }
  });

  function bumpActivity() {
    lastActivityAt = Date.now();
  }

  // Тик активного времени запускается только после первой реальной интеракции
  // (см. handleUserActivity). Бот, открывший страницу и ничего не делающий,
  // таймер не крутит.
  function startActiveTimeTicker() {
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivityAt < IDLE_THRESHOLD) {
        activeTime += 1000;
      }
    }, 1000);
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

      // Глубина прочтения: максимум за сессию, в долях документа.
      var doc = document.documentElement || document.body;
      var total = doc ? doc.scrollHeight : 0;
      if (total > 0) {
        var scrolled = (window.scrollY || window.pageYOffset || 0) + (window.innerHeight || 0);
        var depth = scrolled / total;
        if (depth > maxScrollDepth) maxScrollDepth = depth > 1 ? 1 : depth;
      }

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

  // ===== Скоринг =====
  // Каждый сигнал даёт нормированный вклад 0..max. Слабые сигналы могут
  // компенсироваться сильными (долгое чтение без скролла, или короткий визит
  // с copy-event и максимальной глубиной — обе ситуации зачитываются).
  //
  // Веса откалиброваны под общий потолок 100 при насыщении большинства
  // сигналов. Реальные пороги под конкретный сайт подбираются по
  // распределению параметра score в Метрике.
  function calculateScore() {
    var s = 0;
    var visibleSec = getVisibleTime() / 1000;
    var activeSec = activeTime / 1000;

    s += Math.min(visibleSec / 60, 1) * 25;          // до 25 за 60 сек видимого
    s += Math.min(activeSec / 30, 1) * 25;           // до 25 за 30 сек активного
    s += Math.min(maxScrollDepth, 1) * 20;           // до 20 за 100% глубины
    if (textSelected) s += 10;
    if (copied) s += 15;                             // copy сильнее selection
    if (visitCount >= 2) s += 5;
    if (visitCount >= 5) s += 5;
    return s;                                         // потолок 105, на практике <= 100
  }

  // ===== Цель =====
  // goalReachedThisSession — сессионный (in-memory) флаг: при перезагрузке
  // вкладки сбрасывается, при SPA-навигации сохраняется. Жёсткий cap — это
  // дневной счётчик в localStorage.
  //
  // Семантика «качественного пользователя»:
  //  - score >= GOAL_SCORE_THRESHOLD (взвешенная сумма сигналов),
  //  - И минимальный гейт: пользователь реально присутствовал на странице,
  //    чтобы score=10 от visitCount=5+ один не пробивал порог в отрыве от
  //    текущей сессии.
  function trackInterestedUser() {
    if (goalReachedThisSession) return;
    if (!isUserActive) return;

    var visibleMs = getVisibleTime();
    var liveSignal = hasScrolled
      || hasMouseMoved
      || textSelected
      || copied
      || deviceMotionDetected
      || deviceOrientationDetected;

    // Минимальный гейт: половина исторических порогов плюс хоть один сигнал.
    // Без него «горячий» visitCount или длинный idle на открытой вкладке мог
    // бы натянуть score на ровном месте.
    var minGate = visibleMs >= MIN_TIME_ON_SITE / 2
      && activeTime >= MIN_ACTIVE_TIME / 2
      && liveSignal;
    if (!minGate) return;

    var score = calculateScore();
    if (score < GOAL_SCORE_THRESHOLD) return;
    if (isBot()) return;
    if (!isWithinDailyLimit()) return;
    if (typeof window.ym !== 'function') return;

    var params = {
      score: Math.round(score),
      visible_time_sec: Math.round(visibleMs / 1000),
      active_time_sec: Math.round(activeTime / 1000),
      scroll_depth_pct: Math.round(maxScrollDepth * 100),
      visit_count: visitCount,
      text_selected: textSelected ? 1 : 0,
      copied: copied ? 1 : 0
    };

    // params как параметры цели — для отчёта «Конверсии» в Метрике.
    window.ym(METRIKA_COUNTER_ID, 'reachGoal', METRIKA_TARGET, params);
    // userParams привязаны к ClientID и доступны для построения сегментов
    // в Аудиториях Яндекса (look-alike в Директе). Без этого параметры
    // видны только в отчёте по цели, но не в сегментации аудитории.
    if (typeof window.ym === 'function') {
      window.ym(METRIKA_COUNTER_ID, 'userParams', {
        quality_score: Math.round(score),
        quality_visit_count: visitCount
      });
    }
    incrementDailyCount();
    goalReachedThisSession = true;
  }

  // ===== Обработчики активности =====
  function handleUserActivity() {
    bumpActivity();
    if (isUserActive) return;
    isUserActive = true;
    startActiveTimeTicker();
    // Периодически проверяем условия цели. Один setTimeout под фиксированный
    // порог не годится: visibleTime и activeTime растут не линейно от часов
    // на стене (фоновые вкладки/idle их останавливают), поэтому опрашиваем
    // условие каждые 5 секунд, пока цель не сработает или сессия не закончится.
    // Интервал не самоостанавливается, если цель так и не сработает — это
    // by design: «копеечная» нагрузка, плюс пользователь может квалифицироваться
    // позже за счёт активности после паузы.
    var iv = setInterval(function () {
      if (goalReachedThisSession) {
        clearInterval(iv);
        return;
      }
      trackInterestedUser();
    }, 5000);
  }

  function handleCopy() {
    copied = true;
    bumpActivity();
    trackInterestedUser();
  }

  function handleTextSelection() {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.toString().length > 0) {
      textSelected = true;
      bumpActivity();
      trackInterestedUser();
    }
  }

  function handleDeviceMotion() {
    deviceMotionDetected = true;
    bumpActivity();
    trackInterestedUser();
  }

  function handleDeviceOrientation() {
    deviceOrientationDetected = true;
    bumpActivity();
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
  // Постоянные listener-ы для обновления lastActivityAt — одно место правды
  // для всех источников активности. Дублирование bumpActivity внутри
  // watchMouseVariance/watchScrollVariance специально убрано: если кто-то
  // отрефакторит watch-функции, lastActivityAt не должен сломаться.
  window.addEventListener('mousemove', bumpActivity, { passive: true });
  window.addEventListener('scroll', bumpActivity, { passive: true });
  window.addEventListener('keydown', bumpActivity);
  window.addEventListener('touchstart', bumpActivity, { passive: true });
  window.addEventListener('click', bumpActivity, { passive: true });

  document.addEventListener('copy', handleCopy);

  document.addEventListener('selectionchange', handleTextSelection);

  // DeviceMotion/Orientation работают только на мобильных. На iOS 13+ они
  // требуют DeviceMotionEvent.requestPermission() из user gesture, поэтому
  // без явного UI-разрешения флаги не сработают. На десктопах событий нет
  // вовсе. Это вспомогательный сигнал — основной канал срабатывания цели —
  // visible/active time + скролл/мышь.
  window.addEventListener('devicemotion', throttle(handleDeviceMotion, 1000));
  window.addEventListener('deviceorientation', throttle(handleDeviceOrientation, 1000));

  watchMouseVariance();
  watchScrollVariance();
  watchRequestFrequency();
})();
</script>
