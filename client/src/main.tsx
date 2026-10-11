// Global styles load first so their cascade layers are declared before any page-level CSS.
import './styles.css';
import './pages/operations.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {AuthProvider,AccountBoundary} from './contexts/AuthContext';
import {CartProvider} from './contexts/CartContext';
import App from './App';
import { SyncProvider } from './contexts/SyncContext';
import { ApiError } from './lib/api';
import { ErrorBoundary, reportClientError } from './components/ErrorBoundary';
import { ConfirmationProvider } from './components/Confirm';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:(count,error)=>count<1 && (!(error instanceof ApiError)||error.status>=500)&&!(error instanceof ApiError&&['SETUP_REQUIRED','MAINTENANCE'].includes(error.code||'')),staleTime:30000,refetchInterval:30000,refetchIntervalInBackground:false,refetchOnWindowFocus:true}}});
window.addEventListener('error',()=>reportClientError('UNHANDLED_ERROR'));
window.addEventListener('unhandledrejection',()=>reportClientError('UNHANDLED_REJECTION'));
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><ErrorBoundary><AuthProvider><AccountBoundary><ConfirmationProvider><SyncProvider><CartProvider><App/><Toaster richColors position="bottom-right"/></CartProvider></SyncProvider></ConfirmationProvider></AccountBoundary></AuthProvider></ErrorBoundary></BrowserRouter></QueryClientProvider></React.StrictMode>);
