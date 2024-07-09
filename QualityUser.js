<script>
// Конфигурация метрики
var METRIKA_COUNTER_ID = 12345678; // Используем номер существующего счётчика
var METRIKA_TARGET = 'QualityUser';

// Период времени (в миллисекундах), в течение которого пользователь должен провести на сайте
var MIN_TIME_ON_SITE = 30000; // Например, 30 секунд

// Переменные для отслеживания состояния
var startTime;
var isUserActive = false;
var textSelected = false;
var deviceMotionDetected = false;
var deviceOrientationDetected = false;

// Переменные для отслеживания действий пользователя
var mouseMovements = [];
var scrollEvents = [];
var interactionEvents = [];

// Пороговые значения
var movementThreshold = 10;
var maxMouseMovements = 100;
var maxScrollEvents = 50;
var maxInteractionEvents = 200;

// Проверка поддержки localStorage
function supportsLocalStorage() {
  try {
    var test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch (e) {
    return false;
  }
}

// Функция для отслеживания заинтересованного пользователя
function trackInterestedUser() {
  var currentTime = new Date().getTime();
  var timeOnSite = currentTime - startTime;

  if (isUserActive && (timeOnSite >= MIN_TIME_ON_SITE || textSelected || deviceMotionDetected || deviceOrientationDetected) && !isBot() && isWithinDailyLimit()) {
    ym(METRIKA_COUNTER_ID, 'reachGoal', METRIKA_TARGET);
    incrementDailyCounter();
  }
}

// Функция для определения бота
function isBot() {
  var userAgent = navigator.userAgent.toLowerCase();
  var botPatterns = [/bot/, /crawl/, /spider/, /slurp/, /yahoo/, /mediapartners/, /adsbot/, /bingbot/, /googlebot/, /baiduspider/, /yandexbot/, /sogou/, /exabot/, /facebot/, /ia_archiver/];
  var isBot = botPatterns.some(function(pattern) {
    return pattern.test(userAgent);
  });

  // Дополнительная проверка на основе поведения
  var suspiciousBehaviors = [
    function() { return window.innerWidth === 0 && window.innerHeight === 0; }, // Скрытый iframe
    function() { return navigator.webdriver; }, // Headless браузер
    function() { return isHeadless(); }, // Дополнительная проверка на headless
    function() { return isUsingProxy(); }, // Проверка на использование прокси
    function() { return hasSuspiciousBehavior(); } // Проверка на подозрительное поведение
  ];

  var isSuspiciousBehavior = suspiciousBehaviors.some(function(check) {
    return check();
  });

  return isBot || isSuspiciousBehavior;
}

// Функция для проверки headless браузеров
function isHeadless() {
  return /HeadlessChrome/.test(window.navigator.userAgent) || /Googlebot/.test(window.navigator.userAgent) || (navigator.webdriver && !window.chrome);
}

// Функция для определения использования прокси
function isUsingProxy() {
  // Данный метод можно оставить, но стоит учитывать его ограниченную эффективность
  var proxyHeaders = [
    'HTTP_X_FORWARDED_FOR', 
    'HTTP_X_FORWARDED', 
    'HTTP_FORWARDED_FOR', 
    'HTTP_CLIENT_IP', 
    'HTTP_VIA', 
    'HTTP_PROXY_CONNECTION',
    'HTTP_X_REAL_IP' // Добавлен дополнительный заголовок
  ];

  return proxyHeaders.some(function(header) {
    return window.navigator[header] !== undefined;
  });
}

// Функция для проверки подозрительного поведения
function hasSuspiciousBehavior() {
  return hasSuspiciousMouseMovements() || hasSuspiciousScrollBehavior() || hasSuspiciousRequestFrequency();
}

// Функция для проверки подозрительных движений мыши
function hasSuspiciousMouseMovements() {
  var suspicious = false;
  var lastX, lastY;
  var movementHistory = [];
  var maxHistoryLength = 20;

  window.addEventListener('mousemove', function(event) {
    if (lastX !== undefined && lastY !== undefined) {
      var deltaX = Math.abs(event.clientX - lastX);
      var deltaY = Math.abs(event.clientY - lastY);

      movementHistory.push({ deltaX: deltaX, deltaY: deltaY });

      if (movementHistory.length > maxHistoryLength) {
        movementHistory.shift();
      }

      if (movementHistory.length === maxHistoryLength) {
        var totalDeltaX = movementHistory.reduce(function(sum, move) { return sum + move.deltaX; }, 0);
        var totalDeltaY = movementHistory.reduce(function(sum, move) { return sum + move.deltaY; }, 0);
        var averageDeltaX = totalDeltaX / movementHistory.length;
        var averageDeltaY = totalDeltaY / movementHistory.length;

        var varianceX = movementHistory.reduce(function(sum, move) { return sum + Math.pow(move.deltaX - averageDeltaX, 2); }, 0) / movementHistory.length;
        var varianceY = movementHistory.reduce(function(sum, move) { return sum + Math.pow(move.deltaY - averageDeltaY, 2); }, 0) / movementHistory.length;

        if (varianceX < 1 && varianceY < 1) {
          suspicious = true;
        }
      }
    }
    lastX = event.clientX;
    lastY = event.clientY;
  });

  return suspicious;
}

// Функция для проверки подозрительного поведения прокрутки
function hasSuspiciousScrollBehavior() {
  var suspicious = false;
  var lastScrollY;
  var scrollHistory = [];
  var maxHistoryLength = 20;

  window.addEventListener('scroll', function() {
    var currentScrollY = window.scrollY || window.pageYOffset;

    if (lastScrollY !== undefined) {
      var deltaY = Math.abs(currentScrollY - lastScrollY);

      scrollHistory.push(deltaY);

      if (scrollHistory.length > maxHistoryLength) {
        scrollHistory.shift();
      }

      if (scrollHistory.length === maxHistoryLength) {
        var totalDeltaY = scrollHistory.reduce(function(sum, deltaY) { return sum + deltaY; }, 0);
        var averageDeltaY = totalDeltaY / scrollHistory.length;

        var varianceY = scrollHistory.reduce(function(sum, deltaY) { return sum + Math.pow(deltaY - averageDeltaY, 2); }, 0) / scrollHistory.length;

        if (varianceY < 1) {
          suspicious = true;
        }
      }
    }
    lastScrollY = currentScrollY;
  });

  return suspicious;
}

// Функция для проверки подозрительной частоты запросов
function hasSuspiciousRequestFrequency() {
  var requests = [];
  var requestLimit = 10; // Лимит запросов в минуту
  var timeLimit = 60000; // Временной лимит в миллисекундах

  function logRequest() {
    var now = Date.now();
    requests.push(now);
    requests = requests.filter(function(timestamp) {
      return now - timestamp < timeLimit;
    });
    return requests.length > requestLimit;
  }

  window.addEventListener('load', logRequest);
  window.addEventListener('mousemove', logRequest);
  window.addEventListener('scroll', logRequest);
  window.addEventListener('keydown', logRequest);
  window.addEventListener('touchstart', logRequest);

  return logRequest();
}

// Хранилище для счетчика срабатываний цели в день
var dailyCounterStorageKey = 'interested_user_daily_counter';
var maxGoalCountPerDay = 3;

// Функция для проверки, не превышено ли ограничение срабатывания цели в день
function isWithinDailyLimit() {
  var dailyCounter = getDailyCounterFromStorage() || 0;
  return dailyCounter < maxGoalCountPerDay;
}

// Функция для увеличения счетчика срабатываний цели в день
function incrementDailyCounter() {
  var dailyCounter = getDailyCounterFromStorage() || 0;
  dailyCounter++;
  setDailyCounterToStorage(dailyCounter);
}

// Функция для получения счетчика срабатываний цели в день из хранилища
function getDailyCounterFromStorage() {
  if (supportsLocalStorage()) {
    return parseInt(localStorage.getItem(dailyCounterStorageKey));
  }
  return null;
}

// Функция для сохранения счетчика срабатываний цели в день в хранилище
function setDailyCounterToStorage(value) {
  if (supportsLocalStorage()) {
    localStorage.setItem(dailyCounterStorageKey, value);
  }
}

// Обработчик события, который вызывается при активности пользователя на сайте
function handleUserActivity() {
  if (!isUserActive) {
    isUserActive = true;
    startTime = new Date().getTime();
    setTimeout(trackInterestedUser, MIN_TIME_ON_SITE);
  }
}

// Обработчик события, который вызывается при выделении текста
function handleTextSelection() {
  if (window.getSelection().toString().length > 0) {
    textSelected = true;
    trackInterestedUser();
  }
}

// Функция троттлинга
function throttle(fn, wait) {
  var time = Date.now();
  return function() {
    if ((time + wait - Date.now()) < 0) {
      fn();
      time = Date.now();
    }
  };
}

// Обработчик события для devicemotion
function handleDeviceMotion(event) {
  deviceMotionDetected = true;
  trackInterestedUser();
}

// Обработчик события для deviceorientation
function handleDeviceOrientation(event) {
  deviceOrientationDetected = true;
  trackInterestedUser();
}

// Добавляем обработчики событий для отслеживания активности пользователя
['load', 'mousemove', 'keydown', 'scroll', 'touchstart'].forEach(function(eventType) {
  window.addEventListener(eventType, handleUserActivity, { once: true });
});

// Добавляем обработчик события для выделения текста
document.addEventListener('selectionchange', handleTextSelection);

// Добавляем обработчики событий для devicemotion и deviceorientation с троттлингом
window.addEventListener('devicemotion', throttle(handleDeviceMotion, 1000));
window.addEventListener('deviceorientation', throttle(handleDeviceOrientation, 1000));
</script>
