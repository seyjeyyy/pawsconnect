import { useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { Bell, LogOut, PawPrint, UserRound } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { homePath, isOperational, roleTitle } from '../../lib/roles';
import { SyncStatus } from '../../contexts/SyncContext';
import { MaintenanceNotice } from '../MaintenanceNotice';
import { TourButton, TourInvitation } from '../tour/Tour';
import './workspace.css';

export default function WorkspaceLayout() {
  const {user, roles, profile, signOut} = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  async function logout() {
    try { await signOut(); navigate('/auth/login', {replace:true}); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign out. Please try again.'); }
  }
  return <div className="workspace-shell">
    <a className="skip-link" href="#main">Skip to main content</a>
    <header className="workspace-header"><div className="container workspace-header-inner">
      <Link className="workspace-brand" to={homePath(roles)}><PawPrint size={26}/><span>PawsConnect<small>{isOperational(roles) ? roleTitle(roles) : roles.includes('volunteer') ? 'Volunteer workspace' : 'My account'}</small></span></Link>
      <nav aria-label="Workspace shortcuts" className="workspace-shortcuts">
        <TourButton/>
        <Link to="/welcome">View website</Link>
        {user ? <>
          <Link to="/account/notifications" aria-label="Notifications"><Bell size={18}/></Link>
          <Link to="/account/profile" className="workspace-user"><UserRound size={18}/><span>{profile?.full_name || 'My profile'}</span></Link>
          <button className="text-button" onClick={logout}><LogOut size={17}/>Sign out</button>
        </> : <Link to="/auth/login">Sign in</Link>}
      </nav>
    </div></header>
    <SyncStatus/><MaintenanceNotice/>
    {error && <div className="container notice error" role="alert">{error}</div>}
    <main id="main" tabIndex={-1}><Outlet/></main>
    <TourInvitation/>
  </div>;
}
