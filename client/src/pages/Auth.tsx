import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Eye, EyeOff, PawPrint, ShieldCheck } from 'lucide-react';
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
  return <main className="auth-page"><div className="auth-story"><Link to="/" className="auth-brand"><PawPrint />PawsConnect</Link><div><span className="eyebrow">A LITTLE LOVE GOES A LONG WAY.</span><h1>One account.<br />So many ways<br />to care.</h1><p>Find a companion. Fill a food bowl. Lend a hand.<br />Your next good thing starts here.</p><img src="https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=700&q=85" alt="A friendly golden retriever" /></div><p className="small">Supporting PawsConnect · Bulacan, Philippines</p></div><div className="auth-content"><form className="auth-form" onSubmit={handleSubmit(submit)}><span className="eyebrow">WELCOME TO THE COMMUNITY</span><h1>{registration ? 'Make yourself at home.' : forgot ? 'Forgot your password?' : reset ? 'A fresh start.' : 'Good to see you again.'}</h1><p className="muted">{registration ? 'Create an account to shop, adopt, and make a difference.' : forgot ? 'Enter your email and we’ll send a recovery link.' : reset ? 'Choose a new, secure password for your account.' : 'Sign in and pick up where you left off.'}</p>{!auth.configured && <div className="notice">Account services are awaiting Supabase configuration. Records are unavailable until the connection is restored.</div>}{registration && <label className="field">Full name<input {...register('name')} autoComplete="name" required placeholder="Your full name" /></label>}{!reset && <label className="field">Email address<input {...register('email')} type="email" autoComplete="email" placeholder="you@example.com" />{errors.email && <small className="error">{errors.email.message}</small>}</label>}{!forgot && <label className="field">{reset ? 'New password' : 'Password'}<span className="password-field"><input {...register('password')} aria-label={reset ? 'New password' : 'Password'} type={showPassword ? 'text' : 'password'} autoComplete={registration || reset ? 'new-password' : 'current-password'} placeholder="At least 10 characters" /><button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-pressed={showPassword} aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>{errors.password && <small className="error">{errors.password.message}</small>}</label>}{mode === 'login' && <Link className="auth-forgot" to="/auth/forgot">Forgot password?</Link>}{registration && <p className="small muted">Your account starts with community access. Shelter operational roles are assigned only by an authorized administrator.</p>}<Notice error={error} success={success} /><button className="btn btn-primary" disabled={isSubmitting}>{isSubmitting ? 'Please wait…' : registration ? 'Create my account' : forgot ? 'Send reset link' : reset ? 'Update password' : 'Sign in'}<ArrowRight size={17} /></button><p className="auth-switch">{registration ? <>Already part of the community? <Link to="/auth/login">Sign in</Link></> : forgot || reset ? <Link to="/auth/login">Back to sign in</Link> : <>New around here? <Link to="/auth/register">Create an account</Link></>}</p><div className="auth-reassurance"><ShieldCheck size={18} /><span>Secure accounts. Thoughtful care. Happy paws.</span></div></form></div></main>;
}
