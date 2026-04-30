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
  var QUALITY_TOTAL_KEY = 'interested_user_quality_total';
  var QUALITY_SCORE_MAX_KEY = 'interested_user_quality_score_max';
  var QUALITY_INTERNAL_NAV_MAX_KEY = 'interested_user_quality_internal_nav_max';
  var INTERNAL_NAV_KEY = 'interested_user_internal_nav';     // { count, ts } TTL 5 мин
  var INTERNAL_NAV_TTL_MS = 5 * 60 * 1000;
  // 30 минут — это и стандартный visit-gap в самой Яндекс Метрике, поэтому
  // visitCount у нас совпадает с тем, как Метрика считает визиты.
  var SAME_SESSION_GAP_MS = 30 * 60 * 1000;
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
  var exitIntent = false;             // Курсор уехал за верхнюю границу окна

  // ===== Скролл-скорость (анализ «пролетел не читая») =====
  var scrollFastDistance = 0;         // px, проеханные на скорости > FAST_SCROLL_PPS
  var scrollTotalDistance = 0;        // px, проеханные за всю сессию
  var FAST_SCROLL_PPS = 3000;         // выше этого — «полёт», не чтение
  var FAST_SCROLL_RATIO = 0.7;        // если > 70% пути проеханы быстро — штрафуем
  var FAST_SCROLL_MIN_TOTAL = 1000;   // штраф включается только если есть существенный путь

  // ===== Внутренняя навигация (с persistence через localStorage) =====
  // На multi-page сайтах счётчик в памяти умирает с перезагрузкой; пишем
  // в storage с TTL, на следующей странице читаем как стартовое значение.
  var internalNavClicks = 0;

  // ===== Чтение по секциям (replacement для глобальной глубины) =====
  // Если на странице есть размеченный контент (main/article/[role=main])
  // с >= READING_MIN_SECTIONS параграфами/заголовками — считаем «прочитанные»
  // секции через IntersectionObserver. Иначе fallback на maxScrollDepth.
  var readSections = 0;
  var totalSections = 0;
  var READING_MIN_SECTIONS = 5;

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
  // а не «вернувшийся пользователь».
  //
  // LAST_VISIT_AT_KEY обновляется ТОЛЬКО в ветке isFreshVisit. Если бы мы
  // обновляли его на каждом загрузке скрипта, окно SAME_SESSION_GAP_MS
  // сдвигалось бы вперёд при каждом рефреше — пользователь, который ходит
  // по сайту с разрывами по 25 минут весь день, навсегда оставался бы на
  // visitCount=1. Текущая семантика: 30 минут отсчитываются от начала визита,
  // а не от последнего рефреша внутри визита. Это согласуется с тем, как
  // визит определяет сама Яндекс Метрика, и это сознательный выбор —
  // не «починять» обратно при следующем ревью.
  //
  // Известное следствие: visitCount захватывается один раз при загрузке
  // скрипта. Если пользователь сидит на сайте дольше SAME_SESSION_GAP_MS
  // и квалифицируется уже во «втором» визите по логике Метрики — параметр
  // цели visit_count покажет старое значение. quality_visits_total в
  // userParams (агрегат за всё время) это компенсирует для look-alike.
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
      localStorage.setItem(LAST_VISIT_AT_KEY, String(now));
    } else if (n === 0) {
      // Первый замер при отсутствующем счётчике, но lastAt свежий —
      // экзотика, не должна приводить к visitCount=0.
      n = 1;
      localStorage.setItem(VISIT_COUNT_KEY, '1');
      localStorage.setItem(LAST_VISIT_AT_KEY, String(now));
    }
    return n;
  }
  var visitCount = bumpVisitCount();

  // Подхватываем internalNavClicks из предыдущей страницы, если запись свежая.
  // Старее TTL — игнорируем (это уже не «текущая навигация», а история).
  function readInternalNavFromStorage() {
    if (!supportsLocalStorage()) return 0;
    var raw = localStorage.getItem(INTERNAL_NAV_KEY);
    if (!raw) return 0;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.count === 'number' && typeof parsed.ts === 'number') {
        if (Date.now() - parsed.ts < INTERNAL_NAV_TTL_MS) return parsed.count;
      }
    } catch (e) { /* битая запись — обнуляем */ }
    return 0;
  }
  internalNavClicks = readInternalNavFromStorage();

  function persistInternalNav() {
    if (!supportsLocalStorage()) return;
    if (internalNavClicks <= 0) return;
    localStorage.setItem(INTERNAL_NAV_KEY, JSON.stringify({
      count: internalNavClicks,
      ts: Date.now()
    }));
  }

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
  // таймер не крутит. Сам интервал не самоостанавливается до закрытия
  // вкладки — by design, как и проверочный iv в handleUserActivity:
  // 1 такт/сек это копейки, а пользователь может квалифицироваться позже
  // за счёт активности после паузы.
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
  // Здесь же замеряем скорость скролла (px/sec) и копим долю «быстрого»
  // пути для штрафа в скоринге — см. fastScrollPenalty().
  function watchScrollVariance() {
    var lastY;
    var lastScrollAt = 0;
    var history = [];
    var maxLen = 20;

    window.addEventListener('scroll', function () {
      hasScrolled = true;

      // Глубина прочтения: максимум за сессию, в долях документа.
      // Используется как fallback, если контентных секций <READING_MIN_SECTIONS.
      var doc = document.documentElement || document.body;
      var total = doc ? doc.scrollHeight : 0;
      if (total > 0) {
        var scrolled = (window.scrollY || window.pageYOffset || 0) + (window.innerHeight || 0);
        var depth = scrolled / total;
        if (depth > maxScrollDepth) maxScrollDepth = depth > 1 ? 1 : depth;
      }

      var y = window.scrollY || window.pageYOffset;
      var now = Date.now();

      // Скорость и доля «быстрого» пути.
      if (lastY !== undefined && lastScrollAt > 0) {
        var dy = Math.abs(y - lastY);
        var dt = now - lastScrollAt;
        if (dt > 0 && dy > 0) {
          var pps = dy * 1000 / dt;
          scrollTotalDistance += dy;
          if (pps > FAST_SCROLL_PPS) scrollFastDistance += dy;
        }
      }

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
      lastScrollAt = now;
    }, { passive: true });
  }

  // Штраф за «полёт без чтения»: если существенная часть проеханного пути
  // была на скорости > FAST_SCROLL_PPS — это не чтение, а пролистывание.
  // Один трекпадный флик (резкий жест) даёт малый fastDistance относительно
  // последующего медленного скролла — поэтому считаем долю, а не штрафуем
  // за каждый сэмпл.
  function fastScrollPenalty() {
    if (scrollTotalDistance < FAST_SCROLL_MIN_TOTAL) return 0;
    if (scrollFastDistance / scrollTotalDistance > FAST_SCROLL_RATIO) return 10;
    return 0;
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

  // ===== Чтение по секциям =====
  // Если в контентной зоне (main/article/[role=main]) есть достаточное число
  // секций — мерим время каждого <p>/<h2>/<h3>/<li> в viewport. Зачёт даём
  // когда секция набрала dwell, пропорциональный её длине (200 мс на слово,
  // не меньше 800 мс): на коротком абзаце 1-2 строки человек проводит
  // 800-1200 мс, и фиксированный 1500 мс пропускал бы половину легитимного
  // чтения. На длинном абзаце 50 слов — 10 сек.
  //
  // Если контентных секций < READING_MIN_SECTIONS — fallback на старую
  // глобальную глубину (см. readingProgress()). На SPA, где контент
  // подгружается после DOMContentLoaded, дополнительно ждём через
  // MutationObserver (см. ensureReadingTracker).
  var READING_SECTION_SELECTOR =
    'main p, main h2, main h3, main li, ' +
    'article p, article h2, article h3, article li, ' +
    '[role="main"] p, [role="main"] h2, [role="main"] h3, [role="main"] li';
  var readingTrackerInitialized = false;

  function setupReadingTracker() {
    if (readingTrackerInitialized) return;
    if (typeof window.IntersectionObserver !== 'function') return;

    var els;
    try {
      els = document.querySelectorAll(READING_SECTION_SELECTOR);
    } catch (e) { return; }

    if (els.length < READING_MIN_SECTIONS) {
      totalSections = 0;  // явно сигналим fallback в readingProgress()
      return;
    }

    readingTrackerInitialized = true;
    totalSections = els.length;

    var dwell = {};       // id → { since, total, counted, threshold }
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.setAttribute('data-qu-sid', String(i));
      var text = (el.textContent || '').trim();
      var words = text ? text.split(/\s+/).length : 0;
      dwell[i] = {
        since: 0,
        total: 0,
        counted: false,
        threshold: Math.max(800, words * 200)
      };
    }

    var io = new IntersectionObserver(function (entries) {
      for (var k = 0; k < entries.length; k++) {
        var e = entries[k];
        var sid = e.target.getAttribute('data-qu-sid');
        if (sid === null) continue;
        var d = dwell[sid];
        if (!d) continue;

        if (e.isIntersecting) {
          d.since = Date.now();
        } else if (d.since) {
          d.total += Date.now() - d.since;
          d.since = 0;
          if (!d.counted && d.total >= d.threshold) {
            d.counted = true;
            readSections++;
          }
        }
      }
    }, { threshold: 0.5 });

    for (var j = 0; j < els.length; j++) io.observe(els[j]);
  }

  // На SPA-сайтах контент рендерится после DOMContentLoaded (Next.js, Nuxt,
  // Vue с гидрацией). Если первая попытка setupReadingTracker не нашла
  // достаточно секций — наблюдаем за DOM и пробуем ещё раз, когда контент
  // появится. Стоп через READING_OBSERVE_TIMEOUT_MS — иначе на сайтах вовсе
  // без размеченного <main> наблюдатель тикал бы на каждое DOM-изменение
  // до закрытия вкладки.
  var READING_OBSERVE_TIMEOUT_MS = 30000;
  function ensureReadingTracker() {
    setupReadingTracker();
    if (readingTrackerInitialized) return;
    if (typeof window.MutationObserver !== 'function') return;
    if (!document.body) return;

    var mo = new MutationObserver(function () {
      var els = document.querySelectorAll(READING_SECTION_SELECTOR);
      if (els.length >= READING_MIN_SECTIONS) {
        mo.disconnect();
        setupReadingTracker();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, READING_OBSERVE_TIMEOUT_MS);
  }

  // Доля прочитанных секций / fallback на глобальную глубину.
  // Возвращает значение в диапазоне 0..1, которое умножается на 20 в скоре.
  function readingProgress() {
    if (totalSections >= READING_MIN_SECTIONS) {
      return Math.min(readSections / totalSections, 1);
    }
    return Math.min(maxScrollDepth, 1);   // fallback
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
    s += readingProgress() * 20;                     // до 20 за прочитанные секции (или fallback на глубину)

    // Selection и copy — два сигнала чтения, copy сильнее. Берём максимум,
    // а не сумму: copy почти всегда сопровождается selection, и складывая
    // их мы давали бы непропорционально большой вес одному и тому же
    // действию.
    if (copied) s += 15;
    else if (textSelected) s += 10;

    if (visitCount >= 2) s += 5;
    if (visitCount >= 5) s += 5;

    // Внутренняя навигация — сильный сигнал глубокого интереса. На MPA
    // персистится в storage между страницами, поэтому даже на первой
    // странице после клика бонус начислится.
    if (internalNavClicks >= 1) s += 10;
    if (internalNavClicks >= 3) s += 5;

    s -= fastScrollPenalty();                        // штраф за «пролетел не читая»
    if (s < 0) s = 0;
    return s > 100 ? 100 : s;                         // нормируем строго в 0..100
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
      reading_pct: Math.round(readingProgress() * 100),
      visit_count: visitCount,
      text_selected: textSelected ? 1 : 0,
      copied: copied ? 1 : 0,
      internal_nav: internalNavClicks,
      exit_intent: exitIntent ? 1 : 0,
      fast_scroll_pen: fastScrollPenalty()
    };

    // params как параметры цели — для отчёта «Конверсии» в Метрике.
    window.ym(METRIKA_COUNTER_ID, 'reachGoal', METRIKA_TARGET, params);

    // userParams привязаны к ClientID и доступны для построения сегментов
    // в Аудиториях Яндекса (look-alike в Директе). userParams — это
    // «последнее значение» по ключу, поэтому для look-alike важнее писать
    // АГРЕГАТЫ ЗА ВСЁ ВРЕМЯ, а не текущий снапшот: сколько всего раз юзер
    // квалифицировался + максимальный достигнутый score. Это даёт более
    // сильную фичу, чем сиюминутный score, который перезаписывается при
    // следующем срабатывании.
    //
    // Известное ограничение: после goalReachedThisSession эта ветка больше
    // не выполняется в текущей сессии. Если юзер пробил порог рано (score=60)
    // и потом дочитал до конца с copy (score мог бы вырасти до ~95) —
    // quality_score_max за эту сессию зафиксируется на 60. Чинится отдельным
    // путём обновления storage-агрегатов, но это уже redesign и сейчас
    // выгода не очевидна: для look-alike важнее факт квалификации.
    var roundedScore = Math.round(score);
    var totalQuality = 1;
    var maxScore = roundedScore;
    var maxInternalNav = internalNavClicks;
    if (supportsLocalStorage()) {
      totalQuality = (parseInt(localStorage.getItem(QUALITY_TOTAL_KEY), 10) || 0) + 1;
      var prevMax = parseInt(localStorage.getItem(QUALITY_SCORE_MAX_KEY), 10) || 0;
      maxScore = roundedScore > prevMax ? roundedScore : prevMax;
      var prevNavMax = parseInt(localStorage.getItem(QUALITY_INTERNAL_NAV_MAX_KEY), 10) || 0;
      maxInternalNav = internalNavClicks > prevNavMax ? internalNavClicks : prevNavMax;
      localStorage.setItem(QUALITY_TOTAL_KEY, String(totalQuality));
      localStorage.setItem(QUALITY_SCORE_MAX_KEY, String(maxScore));
      localStorage.setItem(QUALITY_INTERNAL_NAV_MAX_KEY, String(maxInternalNav));
    }
    window.ym(METRIKA_COUNTER_ID, 'userParams', {
      quality_score_last: roundedScore,
      quality_score_max: maxScore,
      quality_visits_total: totalQuality,
      quality_internal_nav_last: internalNavClicks,
      quality_internal_nav_max: maxInternalNav,
      quality_reading_pct_last: Math.round(readingProgress() * 100)
    });

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

  // Trailing-edge debounce: вызвать fn один раз после wait мс тишины.
  // Нужен именно trailing для selectionchange: пользователь долго ведёт
  // выделение — десятки событий в секунду; нам важно дождаться окончания
  // выделения, а не реагировать на первое движение.
  function debounce(fn, wait) {
    var t = 0;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = 0; fn(); }, wait);
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

  // Внутренняя навигация: клик по <a[href]> с тем же origin. Считаем только
  // настоящие переходы (не якорные #fragment — они не покидают страницу).
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = (t && t.nodeType === 1) ? t.closest('a[href]') : null;
    if (!a || !a.host) return;
    if (a.host !== location.host) return;            // внешняя ссылка
    if (a.hash && a.pathname === location.pathname) return;  // якорь на той же странице
    internalNavClicks++;
    bumpActivity();
  }, { passive: true });

  // Exit intent: курсор уехал за верхнюю границу окна. Сильный сигнал «уходит,
  // изучив», в скоринг не закладываем (легко пересолить), но пишем как
  // отдельный параметр цели/userParams для сегментации.
  document.addEventListener('mouseleave', function (e) {
    if (e.clientY <= 0) exitIntent = true;
  }, { passive: true });

  // Перед уходом со страницы сохраняем internalNavClicks в storage,
  // чтобы на следующей MPA-странице счётчик подхватился. Дублируем
  // pagehide и visibilitychange→hidden (последний срабатывает раньше
  // на мобильных, где pagehide может не успеть).
  function persistOnExit() { persistInternalNav(); }
  window.addEventListener('pagehide', persistOnExit);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persistOnExit();
  });

  // selectionchange стреляет десятки раз в секунду при ведении выделения
  // мышью. Дебаунсим на 250 мс, чтобы trackInterestedUser/getDailyCount/
  // calculateScore не вызывались каждый кадр.
  document.addEventListener('selectionchange', debounce(handleTextSelection, 250));

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

  // Reading tracker зависит от DOM с контентом. Если скрипт выполняется до
  // парсинга <body>, querySelectorAll вернёт 0 элементов. Запускаем после
  // DOMContentLoaded или сразу, если уже готов. ensureReadingTracker
  // дополнительно ждёт SPA-гидрации через MutationObserver.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureReadingTracker);
  } else {
    ensureReadingTracker();
  }
})();
</script>
