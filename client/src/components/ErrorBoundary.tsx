import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

const reported=new Set<string>();
export function reportClientError(code:'RENDER_ERROR'|'UNHANDLED_ERROR'|'UNHANDLED_REJECTION') {
 if(reported.has(code))return;reported.add(code);
 // Do not transmit exception messages, stacks, URLs or personal data.
 void fetch(`${import.meta.env.VITE_API_URL || '/api'}/operations/client-error`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),signal:AbortSignal.timeout(5000)}).catch(()=>{});
}
export class ErrorBoundary extends Component<{children:ReactNode},{failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(){reportClientError('RENDER_ERROR');}
 render(){return this.state.failed?<section className="page container" role="alert"><div className="card empty-state"><h1>This page couldn’t open.</h1><p>Your saved records are unchanged. Reload the page to try again.</p><button className="btn btn-primary" onClick={()=>window.location.reload()}>Reload page</button><Link className="text-button" to="/" onClick={()=>this.setState({failed:false})}>Return home</Link></div></section>:this.props.children;}
}
