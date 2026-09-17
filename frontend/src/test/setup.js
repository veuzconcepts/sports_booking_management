import '@testing-library/jest-dom';

// Load the real i18n configuration so components render actual English text
// rather than raw keys. Tests then assert on what a user sees, and a missing or
// misspelled key fails the test instead of slipping through.
import '../i18n/index.js';
