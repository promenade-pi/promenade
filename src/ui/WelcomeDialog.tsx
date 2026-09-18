import { useEffect } from 'react';
import { createPortal } from 'react-dom';

function GraduationCapIcon() {
  return (
    <svg viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <path
        d="M11 3 20 7.5 11 12 2 7.5Z M5.5 9.6V14c0 1.4 2.5 2.9 5.5 2.9s5.5-1.5 5.5-2.9V9.6 M20 7.5V13.5"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <path
        d="M11 2.5c2.6 1.5 4.3 4.3 4.3 8 0 2-.7 4.6-1.9 6.1H8.6C7.4 15.1 6.7 12.5 6.7 10.5c0-3.7 1.7-6.5 4.3-8Z"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
      />
      <circle cx="11" cy="9.5" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.7 12.5 4 14.2l.9 3.3M15.3 12.5l2.7 1.7-.9 3.3M9.2 16.6l-.7 3.1h5l-.7-3.1"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <ellipse cx="11" cy="5.5" rx="6.5" ry="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.5V16c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5.5"
        fill="none" stroke="currentColor" strokeWidth="1.4"
      />
      <path d="M4.5 10.75c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <circle cx="8" cy="7" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 18c0-3 2.3-5.2 5.2-5.2s5.2 2.2 5.2 5.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="15.3" cy="7.6" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M14.6 12.95c2.3.2 4.1 2.1 4.1 4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

const FEATURES = [
  { icon: <GraduationCapIcon />, title: 'Research-driven', body: 'Built on the foundations of process mining research' },
  { icon: <RocketIcon />, title: 'Modern & Open', body: 'State-of-the-art web technologies and open standards' },
  { icon: <DatabaseIcon />, title: 'Scalable', body: 'From classroom examples to real-world data' },
  { icon: <PeopleIcon />, title: 'For Everyone', body: 'Researchers, students and practitioners' },
];

/**
 * Onboarding splash — shown on first launch and reopenable from the Help
 * ("?") menu.
 */
export function WelcomeDialog({
  showOnStartup, onShowOnStartupChange, onClose, onTakeTour,
}: {
  showOnStartup: boolean;
  onShowOnStartupChange: (value: boolean) => void;
  onClose: () => void;
  onTakeTour: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal welcome-dialog" role="dialog" aria-modal="true" aria-label="Welcome to Promenade">
        <div className="welcome-header">
          <img src="/promenade-welcome-header.png" alt="" className="welcome-header-img" />
          <button className="welcome-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="welcome-body">
          <div className="welcome-eyebrow">Welcome to Promenade</div>
          <h1 className="welcome-title">
            Powering your <span className="welcome-shiny">Process Intelligence</span> activities
          </h1>
          <p className="welcome-subtitle">
            Based on decades of research. Built with the latest web technologies.
            Designed to be open, scalable, and accessible for everyone who wants to turn data into insights.
          </p>

          <div className="welcome-features">
            {FEATURES.map((f) => (
              <div className="welcome-feature" key={f.title}>
                <div className="welcome-feature-icon">{f.icon}</div>
                <strong>{f.title}</strong>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="welcome-footer">
          <label className="welcome-startup-check">
            <input
              type="checkbox"
              checked={showOnStartup}
              onChange={(e) => onShowOnStartupChange(e.target.checked)}
            />
            Show this welcome dialog on startup
          </label>
          <div className="welcome-footer-actions">
            <button onClick={onTakeTour}>Take a quick tour</button>
            <button className="primary" onClick={onClose}>Get started <span aria-hidden="true">→</span></button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
