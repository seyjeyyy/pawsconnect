import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, ArrowRight, Eye, EyeOff, HeartHandshake, PawPrint, ShieldCheck, ShoppingBag } from 'lucide-react';

import { useAuth } from '../contexts/AuthContext';
import { SessionDestination } from '../components/SessionDestination';
import './features.css';
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the request.';
function Notice({ error, success }: { error?: string; success?: string }) { return <>{error && <div className="notice error" role="alert">{error}</div>}{success && <div className="notice success" role="status">{success}</div>}</>; }
const authSchema = z.object({ name: z.string().optional(), email: z.string().email('Enter a valid email address.'), password: z.string().min(10, 'Use at least 10 characters.').max(72) });
type AuthValues = z.infer<typeof authSchema>;
export function AuthPage() {
  const auth = useAuth(); const params = useParams(); const [search] = useSearchParams();
  const mode = params.mode || search.get('mode') || 'login'; const registration = mode === 'register'; const forgot = mode === 'forgot'; const reset = mode === 'reset';
  const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [showPassword, setShowPassword] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting }, reset: resetForm } = useForm<AuthValues>({ resolver: zodResolver(authSchema), defaultValues: { name: '', email: reset ? 'recovery@pawsconnect.local' : '', password: forgot ? 'recovery-request' : '' } });
  useEffect(() => { setError(''); setSuccess(''); resetForm({ name: '', email: reset ? 'recovery@pawsconnect.local' : '', password: forgot ? 'recovery-request' : '' }); }, [mode, forgot, reset, resetForm]);
  if ((mode === 'login' || registration) && auth.loading) return <main className="page container" role="status">Checking your session…</main>;
  if ((mode === 'login' || registration) && auth.user) return <SessionDestination next={search.get('next')}/>;
  async function submit(values: AuthValues) {
    setError(''); setSuccess('');
    try {
      if (registration) { if (!values.name?.trim()) throw new Error('Please enter your full name.'); await auth.signUp(values.name.trim(), values.email, values.password); setSuccess('Check your email to verify your account, then sign in to get started.'); }
      else if (forgot) { await auth.resetPassword(values.email); setSuccess('If an account exists for that email, a password reset link will be sent.'); }
      else if (reset) { await auth.updatePassword(values.password); setSuccess('Your password has been updated.'); }
      else { await auth.signIn(values.email, values.password); }
    } catch (failure) { setError(messageOf(failure)); }
  }
  return <main className="auth-page">
    <aside className="auth-story">
      <img src="/images/hero-dog.jpg" alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />
      <Link to="/welcome" className="auth-brand"><span className="brand-mark"><PawPrint fill="currentColor" size={22} /></span>PawsConnect</Link>
      <div className="auth-story-copy">
        <h2>One account for everything at the shelter.</h2>
        <ul>
          <li><PawPrint size={18} />Apply to adopt and follow your application</li>
          <li><ShoppingBag size={18} />Order supplies and track delivery</li>
          <li><HeartHandshake size={18} />Report a stray, book transport, or donate</li>
        </ul>
      </div>
    </aside>
    <div className="auth-content">
      <Link className="back-link" to="/welcome"><ArrowLeft size={16} />Back to website</Link>
      <form className="auth-form" onSubmit={handleSubmit(submit)} noValidate={false}>
        {(mode === 'login' || registration) && <nav className="auth-tabs" aria-label="Sign in or create an account"><Link to="/auth/login" className={mode === 'login' ? 'active' : ''} aria-current={mode === 'login' ? 'page' : undefined}>Sign in</Link><Link to="/auth/register" className={registration ? 'active' : ''} aria-current={registration ? 'page' : undefined}>Create account</Link></nav>}
        <div className="auth-heading"><h1>{registration ? 'Create your account' : forgot ? 'Forgot your password?' : reset ? 'Choose a new password' : 'Welcome back'}</h1><p className="muted">{registration ? 'It takes a minute. You can shop, adopt, report and donate with it.' : forgot ? 'Enter your email and we’ll send a link to reset it.' : reset ? 'Use at least 10 characters.' : 'Sign in to pick up where you left off.'}</p></div>
        {!auth.configured && <div className="notice">Account services are awaiting Supabase configuration. Records are unavailable until the connection is restored.</div>}
        {registration && <label className="field">Full name<input {...register('name')} autoComplete="name" required placeholder="Juan Dela Cruz" /></label>}
        {!reset && <label className="field">Email address<input {...register('email')} type="email" autoComplete="email" placeholder="you@example.com" />{errors.email && <small className="error">{errors.email.message}</small>}</label>}
        {!forgot && <label className="field"><span className="auth-label-row">{reset ? 'New password' : 'Password'}{mode === 'login' && <Link className="auth-forgot" to="/auth/forgot">Forgot password?</Link>}</span><span className="password-field"><input {...register('password')} aria-label={reset ? 'New password' : 'Password'} type={showPassword ? 'text' : 'password'} autoComplete={registration || reset ? 'new-password' : 'current-password'} placeholder={mode === 'login' ? 'Your password' : 'At least 10 characters'} /><button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-pressed={showPassword} aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>{errors.password && <small className="error">{errors.password.message}</small>}</label>}
        <Notice error={error} success={success} />
        <button className="btn btn-primary auth-submit" disabled={isSubmitting}>{isSubmitting ? 'Please wait…' : registration ? 'Create my account' : forgot ? 'Send reset link' : reset ? 'Update password' : 'Sign in'}<ArrowRight size={17} /></button>
        {registration && <p className="small muted">New accounts are customer accounts. Staff roles are given only by the shelter’s administrator.</p>}
        {(forgot || reset) && <p className="auth-switch"><Link to="/auth/login">Back to sign in</Link></p>}
        <p className="auth-reassurance"><ShieldCheck size={16} />Your password is never shown to shelter staff.</p>
      </form>
    </div>
  </main>;
}
