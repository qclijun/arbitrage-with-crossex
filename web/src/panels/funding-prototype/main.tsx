import { createRoot } from 'react-dom/client';
import { Prototype } from './Prototype';
import '../../styles.css';
import './prototype.css';

// Three structural variants of Funding Spreads, in an isolated copy of its
// terminal host. No live hooks, API imports, persistence, or production route.
createRoot(document.getElementById('root')!).render(
  import.meta.env.DEV ? <Prototype /> : <p>Throwaway prototype: development only.</p>,
);
