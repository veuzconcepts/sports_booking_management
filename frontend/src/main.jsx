import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import App from './App.jsx';
import { AuthProvider } from './hooks/useAuth.jsx';
import { PromptProvider } from './components/PromptDialog.jsx';
import { LanguageGate } from './i18n/LanguageGate.jsx';
import { ThemeProvider } from './theme/ThemeProvider.jsx';
import './i18n/index.js';
import './styles/global.css';
import './styles/responsive.css';   // shared breakpoints and layout utilities
import './styles/rtl.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* Outside the auth gate: the sign-in screen is branded too. */}
        <ThemeProvider>
          <LanguageGate>
            <PromptProvider>
              <App />
            </PromptProvider>
          </LanguageGate>
        </ThemeProvider>
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              fontFamily: 'Inter, sans-serif',
              fontSize: 13.5,
              borderRadius: 10,
              padding: '10px 14px',
            },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
