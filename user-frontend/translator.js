(() => {
  const REMOTE_BATCH_URL = 'https://translation-app-nine-pied.vercel.app/translate-batch';
  const LOCAL_BATCH_URL = '/api/translate';
  const CACHE_PREFIX = 'watchdna-storelocator-i18n';
  const DEFAULT_LOCALE = 'en';
  const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur']);
  const SUPPORTED_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'SVG', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
  const MIN_TEXT_LEN = 2;

  const targetElements = new Set();
  const sourceCache = new WeakMap();
  const translating = new WeakSet();
  const textTranslating = new WeakSet();
  const originalNodeMap = new Map();
  const lastWrittenText = new WeakMap();

  let currentLocale = DEFAULT_LOCALE;
  let observer = null;
  let started = false;
  let messageListenerAttached = false;
  const allowedOrigins = new Set([window.location.origin]);

  if (document.referrer) {
    try {
      allowedOrigins.add(new URL(document.referrer).origin);
    } catch (error) {
      void error;
    }
  }

  function normalizeLocale(locale) {
    const value = String(locale || '').trim().toLowerCase().replace('_', '-');
    if (!value) return DEFAULT_LOCALE;
    return value.split('-')[0] || DEFAULT_LOCALE;
  }

  function isRtlLocale(locale) {
    return RTL_LANGUAGES.has(normalizeLocale(locale));
  }

  function getStorageKey(locale) {
    return `${CACHE_PREFIX}:${normalizeLocale(locale)}`;
  }

  function readCache(locale) {
    try {
      const raw = window.localStorage.getItem(getStorageKey(locale));
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      void error;
      return {};
    }
  }

  function writeCache(locale, cache) {
    try {
      window.localStorage.setItem(getStorageKey(locale), JSON.stringify(cache));
    } catch (error) {
      void error;
    }
  }

  function getTargetElements() {
    return Array.from(document.querySelectorAll('[data-translate]'));
  }

  function getTranslateMode(element) {
    return String(element.getAttribute('data-translate') || 'text').toLowerCase();
  }

  function getAttributeList(element) {
    const attrValue = String(element.getAttribute('data-translate-attr') || '').trim();
    if (attrValue) {
      return attrValue.split(/[\s,]+/).filter(Boolean);
    }

    return SUPPORTED_ATTRS.filter((attr) => element.hasAttribute(attr));
  }

  function getSourceRecord(element) {
    let record = sourceCache.get(element);
    if (!record) {
      record = { text: undefined, attrs: {} };
      sourceCache.set(element, record);
    }
    return record;
  }

  function syncSource(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

    const record = getSourceRecord(element);
    const translateMode = getTranslateMode(element);

    if (translateMode.includes('text')) {
      record.text = element.textContent || '';
    }

    getAttributeList(element).forEach((attr) => {
      record.attrs[attr] = element.getAttribute(attr) || '';
    });
  }

  function suspendElement(element) {
    translating.add(element);
    window.setTimeout(() => translating.delete(element), 0);
  }

  async function requestTranslations(texts, targetLocale) {
    const payload = {
      texts,
      source: 'en',
      target: normalizeLocale(targetLocale),
    };

    const urls = [LOCAL_BATCH_URL, REMOTE_BATCH_URL];
    let lastError = null;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        const body = await response.json();
        if (Array.isArray(body.translations)) {
          return body.translations;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Translation request failed');
  }

  async function translateBatch(texts, targetLocale) {
    const normalizedLocale = normalizeLocale(targetLocale);
    const cache = readCache(normalizedLocale);
    const uniqueTexts = Array.from(new Set(texts.map((text) => String(text || '').trim()).filter(Boolean)));

    const translations = new Map();
    const missing = [];

    uniqueTexts.forEach((text) => {
      if (Object.prototype.hasOwnProperty.call(cache, text)) {
        translations.set(text, cache[text]);
      } else {
        missing.push(text);
      }
    });

    if (missing.length) {
      const remoteTranslations = await requestTranslations(missing, normalizedLocale);
      missing.forEach((text, index) => {
        const translated = String(remoteTranslations[index] || text);
        cache[text] = translated;
        translations.set(text, translated);
      });
      writeCache(normalizedLocale, cache);
    }

    return translations;
  }

  async function translateElement(element, targetLocale = currentLocale) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;

    const normalizedLocale = normalizeLocale(targetLocale);
    const translateMode = getTranslateMode(element);
    const source = getSourceRecord(element);
    const textTasks = [];
    const attrTasks = [];

    if (translateMode.includes('text')) {
      const currentText = source.text !== undefined ? source.text : (element.textContent || '');
      if (currentText.trim()) {
        textTasks.push(currentText);
      }
    }

    const attrNames = getAttributeList(element);
    attrNames.forEach((attr) => {
      const currentValue = source.attrs[attr] !== undefined ? source.attrs[attr] : (element.getAttribute(attr) || '');
      if (currentValue.trim()) {
        attrTasks.push({ attr, value: currentValue });
      }
    });

    if (!textTasks.length && !attrTasks.length) {
      return;
    }

    suspendElement(element);

    if (normalizedLocale === DEFAULT_LOCALE) {
      if (translateMode.includes('text') && source.text !== undefined) {
        element.textContent = source.text;
      }

      attrTasks.forEach(({ attr, value }) => {
        element.setAttribute(attr, value);
      });
      return;
    }

    const textTranslations = textTasks.length ? await translateBatch(textTasks, normalizedLocale) : new Map();
    const attrTranslations = attrTasks.length ? await translateBatch(attrTasks.map(({ value }) => value), normalizedLocale) : new Map();

    if (translateMode.includes('text') && source.text !== undefined) {
      const key = String(source.text).trim();
      const translatedText = textTranslations.get(key) || textTranslations.get(source.text) || source.text;
      element.textContent = translatedText;
    }

    attrTasks.forEach(({ attr, value }) => {
      const key = String(value).trim();
      const translatedValue = attrTranslations.get(key) || attrTranslations.get(value) || value;
      element.setAttribute(attr, translatedValue);
    });
  }

  async function translateAll(targetLocale = currentLocale) {
    const normalizedLocale = normalizeLocale(targetLocale);
    const elements = getTargetElements();

    elements.forEach((element) => syncSource(element));

    if (normalizedLocale === DEFAULT_LOCALE) {
      elements.forEach((element) => {
        const source = getSourceRecord(element);
        const translateMode = getTranslateMode(element);

        suspendElement(element);

        if (translateMode.includes('text') && source.text !== undefined) {
          element.textContent = source.text;
        }

        getAttributeList(element).forEach((attr) => {
          if (source.attrs[attr] !== undefined) {
            element.setAttribute(attr, source.attrs[attr]);
          }
        });
      });

      return;
    }

    const texts = [];
    elements.forEach((element) => {
      const source = getSourceRecord(element);
      const translateMode = getTranslateMode(element);

      if (translateMode.includes('text') && source.text !== undefined && source.text.trim()) {
        texts.push(source.text);
      }

      getAttributeList(element).forEach((attr) => {
        const value = source.attrs[attr];
        if (value && String(value).trim()) {
          texts.push(value);
        }
      });
    });

    const translations = await translateBatch(texts, normalizedLocale);

    elements.forEach((element) => {
      const source = getSourceRecord(element);
      const translateMode = getTranslateMode(element);

      suspendElement(element);

      if (translateMode.includes('text') && source.text !== undefined) {
        const key = String(source.text).trim();
        element.textContent = translations.get(key) || translations.get(source.text) || source.text;
      }

      getAttributeList(element).forEach((attr) => {
        const value = source.attrs[attr];
        if (value !== undefined) {
          const key = String(value).trim();
          element.setAttribute(attr, translations.get(key) || translations.get(value) || value);
        }
      });
    });
  }

  function shouldSkipTextNode(textNode) {
    let el = textNode && textNode.parentElement;
    while (el) {
      const tag = el.tagName;
      if (tag && EXCLUDED_TAGS.has(tag)) return true;
      if (el.hasAttribute) {
        if (el.hasAttribute('data-translate')) return true; // handled by the [data-translate] path
        if (el.hasAttribute('data-no-translate')) return true;
      }
      if (el.classList && el.classList.contains('no-translate')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function collectAllTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return nodes;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.textContent ? node.textContent.trim() : '';
        if (!text || text.length < MIN_TEXT_LEN) return NodeFilter.FILTER_REJECT;
        if (shouldSkipTextNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  function suspendTextParent(node) {
    const parent = node && node.parentElement;
    if (!parent) return;
    textTranslating.add(parent);
    window.setTimeout(() => textTranslating.delete(parent), 0);
  }

  function writeTranslatedText(node, value) {
    if (!node || !node.parentNode) return;
    suspendTextParent(node);
    node.textContent = value;
    lastWrittenText.set(node, value);
  }

  async function translateTextNodes(textNodes, targetLocale) {
    if (!textNodes || !textNodes.length) return;

    const normalizedLocale = normalizeLocale(targetLocale);

    textNodes.forEach((node) => {
      if (!originalNodeMap.has(node)) {
        originalNodeMap.set(node, node.textContent || '');
      }
    });

    if (normalizedLocale === DEFAULT_LOCALE) {
      textNodes.forEach((node) => {
        const original = originalNodeMap.get(node);
        if (original !== undefined && node.parentNode) {
          writeTranslatedText(node, original);
        }
      });
      return;
    }

    const texts = textNodes
      .map((node) => originalNodeMap.get(node))
      .filter((text) => text !== undefined && String(text).trim().length >= MIN_TEXT_LEN);

    if (!texts.length) return;

    const translations = await translateBatch(texts, normalizedLocale);

    textNodes.forEach((node) => {
      if (!node.parentNode) return;
      const original = originalNodeMap.get(node);
      if (original === undefined) return;
      const translated = translations.get(String(original).trim()) || translations.get(original) || original;
      writeTranslatedText(node, translated);
    });
  }

  async function translateAllTextNodes(targetLocale = currentLocale) {
    const normalizedLocale = normalizeLocale(targetLocale);

    if (normalizedLocale === DEFAULT_LOCALE) {
      originalNodeMap.forEach((original, node) => {
        if (node && node.parentNode) {
          writeTranslatedText(node, original);
        }
      });
      return;
    }

    if (!document.body) return;
    const textNodes = collectAllTextNodes(document.body);
    await translateTextNodes(textNodes, normalizedLocale);
  }

  function ensureObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver((mutations) => {
      const affected = new Set();
      const newTextNodes = new Set();

      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          const translateElement = target.closest ? target.closest('[data-translate]') : null;
          if (translateElement) affected.add(translateElement);
          return;
        }

        if (mutation.type === 'characterData') {
          const textNode = mutation.target;
          const parent = textNode.parentElement;
          const translateElement = parent ? parent.closest('[data-translate]') : null;
          if (translateElement) {
            affected.add(translateElement);
            return;
          }
          if (!parent || textTranslating.has(parent)) return;
          if (lastWrittenText.get(textNode) === textNode.textContent) return;
          if (shouldSkipTextNode(textNode)) return;
          const text = textNode.textContent ? textNode.textContent.trim() : '';
          if (!text || text.length < MIN_TEXT_LEN) return;
          originalNodeMap.delete(textNode);
          newTextNodes.add(textNode);
          return;
        }

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            if (element.matches && element.matches('[data-translate]')) {
              affected.add(element);
            }
            if (element.querySelectorAll) {
              element.querySelectorAll('[data-translate]').forEach((child) => affected.add(child));
            }
            collectAllTextNodes(element).forEach((textNode) => newTextNodes.add(textNode));
            return;
          }

          if (node.nodeType === Node.TEXT_NODE) {
            if (shouldSkipTextNode(node)) return;
            const text = node.textContent ? node.textContent.trim() : '';
            if (!text || text.length < MIN_TEXT_LEN) return;
            newTextNodes.add(node);
          }
        });
      });

      affected.forEach((element) => {
        if (translating.has(element)) return;
        syncSource(element);
        if (currentLocale !== DEFAULT_LOCALE) {
          void translateElement(element, currentLocale);
        }
      });

      if (newTextNodes.size && currentLocale !== DEFAULT_LOCALE) {
        void translateTextNodes(Array.from(newTextNodes), currentLocale);
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }

  function setDocumentLocale(locale) {
    const normalized = normalizeLocale(locale);
    document.documentElement.lang = normalized;
    document.documentElement.dir = isRtlLocale(normalized) ? 'rtl' : 'ltr';
  }

  function attachMessageListener() {
    if (messageListenerAttached) return;
    messageListenerAttached = true;

    window.addEventListener('message', (event) => {
      const message = event && event.data;
      if (!message || message.type !== 'set-locale') return;
      if (allowedOrigins.size && !allowedOrigins.has(event.origin)) return;

      void setLocale(message.locale || DEFAULT_LOCALE);
    });
  }

  async function setLocale(locale) {
    currentLocale = normalizeLocale(locale);
    setDocumentLocale(currentLocale);
    ensureObserver();
    await translateAll(currentLocale);
    await translateAllTextNodes(currentLocale);
    return currentLocale;
  }

  async function bootstrap(options = {}) {
    if (started) {
      return currentLocale;
    }

    started = true;
    const initialLocale = options.locale || new URLSearchParams(window.location.search).get('locale') || document.documentElement.lang || DEFAULT_LOCALE;
    currentLocale = normalizeLocale(initialLocale);
    setDocumentLocale(currentLocale);
    ensureObserver();
    attachMessageListener();
    await translateAll(currentLocale);
    await translateAllTextNodes(currentLocale);
    return currentLocale;
  }

  window.WatchDnaLocale = {
    bootstrap,
    setLocale,
    getLocale: () => currentLocale,
    translateElement,
    translateAll,
    translateAllTextNodes,
    translateText: (text, locale = currentLocale) => {
      const normalized = normalizeLocale(locale);
      if (normalized === DEFAULT_LOCALE) return String(text || '');

      const cache = readCache(normalized);
      const source = String(text || '');
      if (Object.prototype.hasOwnProperty.call(cache, source)) {
        return cache[source];
      }

      return source;
    },
  };
})();