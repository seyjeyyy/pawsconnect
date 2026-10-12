import { Suspense, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, ChevronRight, ExternalLink, LogOut, PawPrint, UserRound } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { homePath, isOperational, roleTitle } from '../../lib/roles';
import { SyncStatus } from '../../contexts/SyncContext';
import { MaintenanceNotice } from '../MaintenanceNotice';
import { TourButton } from '../tour/Tour';
import { BackButton } from '../BackButton';
import './workspace.css';

const pageName = (pathname: string) => {
  const text = (pathname.split('/').filter(Boolean).at(-1) || 'overview').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export default function WorkspaceLayout() {
  const {user, roles, permissions, profile, signOut} = useAuth();
  const {pathname}=useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  async function logout() {
    try { await signOut(); navigate('/auth/login', {replace:true}); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign out. Please try again.'); }
  }
  return <div className="workspace-shell">
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="workspace-header"><div className="container workspace-header-inner">
      <Link className="workspace-brand" to={homePath(roles,permissions)}><PawPrint size={26}/><span>PawsConnect<small>{roleTitle(roles)}</small></span></Link>
      <div className="workspace-trail">
        <BackButton iconOnly fallback={homePath(roles,permissions)} label="Back to the previous page"/>
        <nav className="workspace-breadcrumb" aria-label="Breadcrumb"><Link to={homePath(roles,permissions)}>{isOperational(roles)?'Workspace':'My account'}</Link><ChevronRight size={14} aria-hidden="true"/><span aria-current="page">{pageName(pathname)}</span></nav>
      </div>
      <nav aria-label="Workspace shortcuts" className="workspace-shortcuts">
        <Link to="/welcome" aria-label="View website" title="View website"><ExternalLink size={17}/><span>View website</span></Link>
        {user ? <>
          <Link to="/account/notifications" aria-label="Notifications" title="Notifications"><Bell size={18}/></Link>
          <Link to="/account/profile" className="workspace-user" aria-label="My profile" title="My profile"><UserRound size={18}/><span>{profile?.full_name || 'My profile'}</span></Link>
          <button className="text-button" onClick={logout} aria-label="Sign out" title="Sign out"><LogOut size={17}/><span>Sign out</span></button>
        </> : <Link to="/auth/login">Sign in</Link>}
      </nav>
    </div></header>
    <MaintenanceNotice/>
    <div className="container workspace-meta">
      <TourButton/>
      <SyncStatus/>
    </div>
    {error && <div className="container notice error" role="alert">{error}</div>}
    <main id="main" tabIndex={-1}><Suspense fallback={<div className="container dashboard-skeleton" role="status" aria-label="Loading workspace"><div/><div/><div/></div>}><Outlet/></Suspense></main>
  </div>;
}
