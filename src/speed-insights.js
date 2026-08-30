/**
 * Vercel Speed Insights initialization
 * Tracks web vitals and performance metrics
 * 
 * This script initializes the Speed Insights tracking queue and loads
 * the Vercel Speed Insights script for collecting performance metrics.
 */

// Initialize the Speed Insights queue
window.si = window.si || function() {
  (window.siq = window.siq || []).push(arguments);
};

// Inject the Speed Insights script
(function() {
  // Check if we're in development mode
  const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  
  // In production on Vercel, use the default path
  // In development, use the debug script
  const scriptSrc = isDev 
    ? 'https://va.vercel-scripts.com/v1/speed-insights/script.debug.js'
    : '/_vercel/speed-insights/script.js';
  
  // Check if script is already loaded
  if (document.head.querySelector(`script[src*="speed-insights"]`)) {
    return;
  }
  
  const script = document.createElement('script');
  script.src = scriptSrc;
  script.defer = true;
  script.dataset.sdkn = '@vercel/speed-insights';
  script.dataset.sdkv = '2.0.0';
  
  script.onerror = function() {
    console.log('[Vercel Speed Insights] Failed to load script. This is normal in development without Vercel deployment.');
  };
  
  document.head.appendChild(script);
})();
