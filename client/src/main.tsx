// Global styles load first so their cascade layers are declared before any page-level CSS.
import './styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {AuthProvider,AccountBoundary} from './contexts/AuthContext';
import {CartProvider} from './contexts/CartContext';
import App from './App';
import { SyncProvider } from './contexts/SyncContext';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000,refetchInterval:30000,refetchIntervalInBackground:false,refetchOnWindowFocus:true}}});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider><AccountBoundary><SyncProvider><CartProvider><App/><Toaster richColors position="bottom-right"/></CartProvider></SyncProvider></AccountBoundary></AuthProvider></BrowserRouter></QueryClientProvider></React.StrictMode>);
