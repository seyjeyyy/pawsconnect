// Global styles load first so their cascade layers are declared before any page-level CSS.
import './styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {AuthProvider} from './contexts/AuthContext';
import {CartProvider} from './contexts/CartContext';
import App from './App';
const queryClient=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:30000,refetchOnWindowFocus:false}}});
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><AuthProvider><CartProvider><App/><Toaster richColors position="bottom-right"/></CartProvider></AuthProvider></BrowserRouter></QueryClientProvider></React.StrictMode>);
