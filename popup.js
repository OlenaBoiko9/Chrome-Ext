const MONOBANK_API_URL = 'https://api.monobank.ua/bank/currency';
const CACHE_DURATION = 60000; // 60 seconds - відповідає ліміту API Monobank
const USD_CODE = 840;
const UAH_CODE = 980;

const amountInput = document.getElementById('amountInput');
const usdBtn = document.getElementById('usdBtn');
const uahBtn = document.getElementById('uahBtn');
const resultValue = document.getElementById('resultValue');
const rateInfo = document.getElementById('rateInfo');
const loadingIndicator = document.getElementById('loadingIndicator');
const errorMessage = document.getElementById('errorMessage');
const refreshBtn = document.getElementById('refreshBtn');

let selectedCurrency = 'usd';
let exchangeRate = 41; // fallback значення
let rateBuy = null; // курс для купівлі USD (UAH → USD)
let rateSell = null; // курс для продажу USD (USD → UAH)

// Initialize
async function init() {
  usdBtn.addEventListener('click', () => selectCurrency('usd'));
  uahBtn.addEventListener('click', () => selectCurrency('uah'));
  refreshBtn.addEventListener('click', async () => {
    // Примусове оновлення курсу
    await loadExchangeRate(true);
    calculate();
  });
  
  amountInput.addEventListener('input', calculate);
  amountInput.addEventListener('change', calculate);
  
  // Завантажуємо курс при відкритті popup
  await loadExchangeRate();
  calculate();
}

function selectCurrency(currency) {
  selectedCurrency = currency;
  
  if (currency === 'usd') {
    usdBtn.classList.add('active');
    uahBtn.classList.remove('active');
  } else {
    uahBtn.classList.add('active');
    usdBtn.classList.remove('active');
  }
  
  calculate();
}

// Завантаження курсу валют з кешу або API
async function loadExchangeRate(forceRefresh = false) {
  // Перевіряємо кеш (якщо не форсуємо оновлення)
  if (!forceRefresh) {
    const cached = await getCachedRate();
    if (cached) {
      setExchangeRate(cached.rateBuy, cached.rateSell, cached.timestamp);
      return;
    }
  }
  
  // Завантажуємо з API
  showLoading(true);
  hideError();
  
  try {
    // Виконуємо запит до API Monobank
    const response = await fetch(MONOBANK_API_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      cache: 'no-cache'
    });
    
    // Перевіряємо статус відповіді
    if (!response.ok) {
      const statusText = response.statusText || 'Unknown error';
      throw new Error(`HTTP ${response.status}: ${statusText}`);
    }
    
    // Парсимо JSON відповідь
    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      throw new Error('Помилка парсингу JSON відповіді');
    }
    
    // Перевірка, що дані - це масив
    if (!Array.isArray(data)) {
      throw new Error('Неочікуваний формат відповіді API');
    }
    
    const usdRate = findUSDRate(data);
    
    if (!usdRate) {
      throw new Error('USD курс не знайдено в API');
    }
    
    // Використовуємо rateBuy/rateSell якщо є, інакше rateCross
    // rateBuy - курс купівлі USD (для конвертації UAH → USD)
    // rateSell - курс продажу USD (для конвертації USD → UAH)
    // rateCross - крос-курс (якщо rateBuy/rateSell відсутні)
    const buyRate = usdRate.rateBuy || usdRate.rateCross;
    const sellRate = usdRate.rateSell || usdRate.rateCross;
    
    if (!buyRate || !sellRate) {
      throw new Error('Недостатньо даних про курс');
    }
    
    // Використовуємо timestamp з API (Unix time в секундах), або поточний час як fallback
    // date з API в секундах, перетворюємо в мілісекунди
    // Перевіряємо на null/undefined, а не на truthiness (бо 0 теж falsy, але може бути валідним)
    const apiTimestamp = (usdRate.date != null && typeof usdRate.date === 'number') 
      ? usdRate.date * 1000 
      : Date.now();
    
    // Зберігаємо в кеш
    await saveRateToCache(buyRate, sellRate, apiTimestamp);
    setExchangeRate(buyRate, sellRate, apiTimestamp);
    
  } catch (error) {
    // Безпечна обробка помилок
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetails = error instanceof Error ? error : { error };
    
    console.error('Помилка завантаження курсу з Monobank API:', {
      message: errorMessage,
      details: errorDetails,
      url: MONOBANK_API_URL,
      timestamp: new Date().toISOString()
    });
    
    // Показуємо більш інформативне повідомлення
    let userMessage = 'Не вдалося завантажити курс з Monobank API.';
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
      userMessage = 'Помилка мережі. Перевірте підключення до інтернету.';
    } else if (errorMessage.includes('HTTP')) {
      userMessage = `Помилка сервера: ${errorMessage}`;
    }
    showError(userMessage + ' Використовується останній збережений курс.');
    
    // Спробуємо використати fallback або останній збережений курс
    try {
      const cached = await getCachedRate(true); // force - навіть якщо застарів
      if (cached) {
        setExchangeRate(cached.rateBuy, cached.rateSell, cached.timestamp);
      }
    } catch (cacheError) {
      console.error('Помилка завантаження кешу:', cacheError);
    }
  } finally {
    showLoading(false);
  }
}

// Пошук курсу USD → UAH в масиві курсів
function findUSDRate(rates) {
  return rates.find(rate => 
    rate.currencyCodeA === USD_CODE && 
    rate.currencyCodeB === UAH_CODE
  );
}

// Кешування в chrome.storage
// buy - rateBuy (курс купівлі USD)
// sell - rateSell (курс продажу USD)
// timestamp - час оновлення курсу (мілісекунди)
async function saveRateToCache(buy, sell, timestamp = Date.now()) {
  const data = {
    rateBuy: buy,
    rateSell: sell,
    timestamp: timestamp
  };
  
  return new Promise((resolve) => {
    chrome.storage.local.set({ exchangeRate: data }, resolve);
  });
}

async function getCachedRate(force = false) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['exchangeRate'], (result) => {
        try {
          if (!result || !result.exchangeRate) {
            resolve(null);
            return;
          }
          
          const cached = result.exchangeRate;
          
          // Перевірка валідності кешу
          if (!cached.rateBuy || !cached.rateSell || !cached.timestamp) {
            resolve(null);
            return;
          }
          
          const age = Date.now() - cached.timestamp;
          
          // Якщо кеш свіжий (менше CACHE_DURATION) або force = true
          if (force || age < CACHE_DURATION) {
            resolve(cached);
          } else {
            resolve(null);
          }
        } catch (error) {
          console.error('Помилка обробки кешу:', error);
          resolve(null);
        }
      });
    } catch (error) {
      console.error('Помилка доступу до chrome.storage:', error);
      resolve(null);
    }
  });
}

function setExchangeRate(buy, sell, timestamp) {
  // Валідація параметрів
  if (typeof buy !== 'number' || typeof sell !== 'number' || !timestamp) {
    console.error('setExchangeRate: невалідні параметри', { buy, sell, timestamp });
    return;
  }
  
  rateBuy = buy;
  rateSell = sell;
  exchangeRate = sell; // для зворотної сумісності з updateEmoji
  
  // Оновлюємо відображення курсу (перевіряємо існування елемента)
  if (rateInfo) {
    const date = new Date(timestamp);
    const timeStr = date.toLocaleTimeString('uk-UA', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    rateInfo.textContent = `Курс: 1 USD = ${sell.toFixed(2)} UAH (оновлено ${timeStr})`;
  }
}

function showLoading(show) {
  if (loadingIndicator) {
    loadingIndicator.style.display = show ? 'block' : 'none';
  }
}

function showError(message) {
  if (errorMessage) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
  }
}

function hideError() {
  if (errorMessage) {
    errorMessage.style.display = 'none';
  }
}

function calculate() {
  const amount = parseFloat(amountInput.value) || 0;
  let result = 0;
  let resultCurrency = '';
  
  if (selectedCurrency === 'usd') {
    // Convert USD to UAH (використовуємо rateSell)
    const rate = rateSell || exchangeRate;
    result = amount * rate;
    resultCurrency = 'UAH';
  } else {
    // Convert UAH to USD (використовуємо rateBuy)
    const rate = rateBuy || exchangeRate;
    result = amount / rate;
    resultCurrency = 'USD';
  }
  
  // Display result
  resultValue.textContent = result.toFixed(2) + ' ' + resultCurrency;
}


// Start the app
init();
