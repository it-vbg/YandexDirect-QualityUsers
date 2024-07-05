<script>
// Переменная для номера счётчика метрики
var METRIKA_COUNTER_ID = 12345678; // Используем номер существующего счётчика

// Период времени (в миллисекундах), в течение которого пользователь должен провести на сайте
var MIN_TIME_ON_SITE = 30000; // Например, 30 секунд

// Переменные для времени и активности пользователя
var startTime;
var isUserActive = false;
var textSelected = false;
var deviceMotionDetected = false;
var deviceOrientationDetected = false;

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
    ym(METRIKA_COUNTER_ID, 'reachGoal', 'InterestedUser');
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
    function() { return !!window.callPhantom || !!window._phantom || !!window.phantom; }, // PhantomJS
    function() { return !!window.__nightmare; }, // Nightmare.js
    function() { return !!document.__selenium_unwrapped || !!document.__webdriver_script_fn || !!window.__nightmare; }, // Selenium
    function() { return !!navigator.plugins && navigator.plugins.length === 0; } // Headless Chrome
  ];
  var isSuspiciousBehavior = suspiciousBehaviors.some(function(check) {
    return check();
  });

  return isBot || isSuspiciousBehavior || isUsingProxy();
}

// Функция для определения использования прокси
function isUsingProxy() {
  var usingProxy = false;
  
  // Проверка наличия специфических заголовков HTTP
  var proxyHeaders = [
    'HTTP_X_FORWARDED_FOR', 
    'HTTP_X_FORWARDED', 
    'HTTP_FORWARDED_FOR', 
    'HTTP_CLIENT_IP', 
    'HTTP_VIA', 
    'HTTP_PROXY_CONNECTION',
    'HTTP_X_REAL_IP' // Добавлен дополнительный заголовок
  ];

  proxyHeaders.forEach(function(header) {
    if (window.navigator[header] !== undefined) {
      usingProxy = true;
    }
  });

  // Дополнительная проверка по IP-адресам
  var proxyIPRanges = [
    '10.0.0.0/8',  // Частные сети
    '172.16.0.0/12',
    '192.168.0.0/16'
  ];

  function isInRange(ip, range) {
    var rangeParts = range.split('/');
    var rangeIP = rangeParts[0];
    var subnet = parseInt(rangeParts[1]);
    var ipParts = ip.split('.').map(Number);
    var rangeIPParts = rangeIP.split('.').map(Number);
    var mask = ~(Math.pow(2, 32 - subnet) - 1);

    function ipToLong(ipParts) {
      return ipParts.reduce(function(acc, part, index) {
        return acc + (part << (24 - 8 * index));
      }, 0);
    }

    return (ipToLong(ipParts) & mask) === (ipToLong(rangeIPParts) & mask);
  }

  var userIP = window.navigator.userAgentData && window.navigator.userAgentData.platform ? window.navigator.userAgentData.platform : ''; // Placeholder for actual IP

  if (proxyIPRanges.some(function(range) {
    return isInRange(userIP, range);
  })) {
    usingProxy = true;
  }

  return usingProxy;
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
  var selection = window.getSelection();
  if (selection.toString().length > 0) {
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
  }
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
