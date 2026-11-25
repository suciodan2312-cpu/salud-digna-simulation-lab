import type { Metadata } from 'next';
import './styles.css';
export const metadata: Metadata = { title: 'Salud Digna Simulation Lab', description: 'Control local y evidencia del motor de simulación.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="es"><body>{children}</body></html>;
}
