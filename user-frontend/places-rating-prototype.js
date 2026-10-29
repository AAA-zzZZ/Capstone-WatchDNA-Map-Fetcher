/* Local-only Places UI Kit trial. Place IDs are selected manually until matching is reviewed. */
(function () {
  const localHost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const enabled = localHost && new URLSearchParams(window.location.search).get('placesPrototype') === '1';
  if (!enabled) return;

  const panel = document.getElementById('storeDetailPanel');
  const phoneSection = document.getElementById('detailPhone')?.closest('.store-detail__section');
  if (!panel) return;

  const section = document.createElement('section');
  section.className = 'store-detail__section places-prototype';
  section.innerHTML = `
    <div class="store-detail__label">Google Maps rating <span class="places-prototype__tag"></span></div>
    <div class="places-prototype__fields">
      <label for="placesPrototypeKey">Browser API key</label>
      <input id="placesPrototypeKey" type="text" autocomplete="off" spellcheck="false" placeholder="Maps API key here">
      <label for="placesPrototypeId">Google Place ID</label>
      <input id="placesPrototypeId" type="text" autocomplete="off" spellcheck="false" placeholder="ChIJ…">
      <div class="places-prototype__buttons">
        <button id="placesPrototypeLoad" type="button">Save and show rating</button>
        <button id="placesPrototypeClear" type="button">Clear match</button>
      </div>
    </div>
    <div id="placesPrototypeStatus" class="places-prototype__status" role="status" aria-live="polite"></div>
    <div id="placesPrototypeWidget" class="places-prototype__widget"></div>
  `;
  if (phoneSection) phoneSection.after(section);
  else panel.append(section);

  const keyInput = section.querySelector('#placesPrototypeKey');
  const idInput = section.querySelector('#placesPrototypeId');
  const status = section.querySelector('#placesPrototypeStatus');
  const widget = section.querySelector('#placesPrototypeWidget');
  let currentStoreKey = '';
  let loadedKey = '';
  let loader = null;
  let renderSequence = 0;

  try { keyInput.value = sessionStorage.getItem('watchdna:places:prototype:key') || ''; } catch {}

  function placeStorageKey(storeKey) {
    return `watchdna:places:prototype:place:${storeKey}`;
  }

  function setStatus(message) {
    status.textContent = message;
  }

  function loadPlacesLibrary(key) {
    if (loader) {
      if (loadedKey !== key) return Promise.reject(new Error('The API key changed. Reload this page to use the new key.'));
      return loader;
    }

    loadedKey = key;
    loader = new Promise((resolve, reject) => {
      const callbackName = '__watchdnaPlacesPrototypeReady';
      const url = new URL('https://maps.googleapis.com/maps/api/js');
      url.searchParams.set('key', key);
      url.searchParams.set('v', 'weekly');
      url.searchParams.set('loading', 'async');
      url.searchParams.set('callback', callbackName);
      const script = document.createElement('script');
      script.async = true;
      script.src = url.toString();
      const timeout = window.setTimeout(() => reject(new Error('Google Maps did not load. Check the key, enabled APIs, and browser console.')), 15000);
      window[callbackName] = async () => {
        window.clearTimeout(timeout);
        try {
          await google.maps.importLibrary('places');
          resolve();
        } catch (error) { reject(error); }
      };
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Could not load Google Maps JavaScript API.'));
      };
      window.gm_authFailure = () => {
        window.clearTimeout(timeout);
        reject(new Error('Google rejected the key or referrer. Check the browser key restrictions and enabled APIs.'));
      };
      document.head.append(script);
    }).catch((error) => {
      loader = null;
      loadedKey = '';
      throw error;
    });
    return loader;
  }

  async function showRating({ save = false } = {}) {
    const sequence = ++renderSequence;
    const key = keyInput.value.trim();
    const placeId = idInput.value.trim();
    widget.replaceChildren();

    if (!key || !placeId) {
      setStatus('Enter both fields.');
      return;
    }
    if (save) {
      try {
        sessionStorage.setItem('watchdna:places:prototype:key', key);
        localStorage.setItem(placeStorageKey(currentStoreKey), placeId);
      } catch {}
    }

    setStatus('Fetching');
    try {
      await loadPlacesLibrary(key);
      if (sequence !== renderSequence) return;

      const details = document.createElement('gmp-place-details');
      const request = document.createElement('gmp-place-details-place-request');
      request.setAttribute('place', placeId);
      const content = document.createElement('gmp-place-content-config');
      content.append(document.createElement('gmp-place-address'));
      content.append(document.createElement('gmp-place-rating'));
      content.append(document.createElement('gmp-place-attribution'));
      details.append(request, content);
      details.addEventListener('gmp-load', () => {
        if (sequence === renderSequence) setStatus(details.place ? '' : 'empty');
      }, { once: true });
      widget.append(details);
    } catch (error) {
      if (sequence === renderSequence) setStatus(error?.message || 'Could not load the rating.');
    }
  }

  section.querySelector('#placesPrototypeLoad').addEventListener('click', () => { void showRating({ save: true }); });
  section.querySelector('#placesPrototypeClear').addEventListener('click', () => {
    ++renderSequence;
    idInput.value = '';
    widget.replaceChildren();
    try { localStorage.removeItem(placeStorageKey(currentStoreKey)); } catch { /* storage may be blocked */ }
    setStatus('Match cleared for this retailer.');
  });

  window.WatchDnaPlacesPrototype = {
    openStore(row) {
      ++renderSequence;
      widget.replaceChildren();
      currentStoreKey = String(row?._locationId || row?.Handle || row?.Name || 'demo');
      try { idInput.value = localStorage.getItem(placeStorageKey(currentStoreKey)) || ''; }
      catch { idInput.value = ''; }
      if (keyInput.value.trim() && idInput.value.trim()) void showRating();
    }
  };
})();
