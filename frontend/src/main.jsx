import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import App from './App.jsx';
import { AuthProvider } from './hooks/useAuth.jsx';
import { PromptProvider } from './components/PromptDialog.jsx';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PromptProvider>
          <App />
        </PromptProvider>
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
