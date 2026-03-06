export const metadata = {
  title: "Privacy Policy — fracmap",
  description: "fracmap privacy policy — how we collect, use, and safeguard your data.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-line">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <a href="/" className="inline-block">
            <svg viewBox="0 0 320 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-[36px] w-auto"><defs><linearGradient id="lgGlow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#f97316"/><stop offset="100%" stopColor="#fb923c"/></linearGradient><linearGradient id="lgText" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f0f0f8"/><stop offset="100%" stopColor="#c8c8d8"/></linearGradient><filter id="lgGl"><feGaussianBlur stdDeviation="3" result="b"/><feComposite in="SourceGraphic" in2="b" operator="over"/></filter></defs><g transform="translate(8,12)"><line x1="20" y1="20" x2="8" y2="8" stroke="#f97316" strokeWidth="1.5" opacity="0.4"/><line x1="20" y1="20" x2="34" y2="6" stroke="#f97316" strokeWidth="1.5" opacity="0.4"/><line x1="20" y1="20" x2="36" y2="28" stroke="#f97316" strokeWidth="1.5" opacity="0.3"/><line x1="20" y1="20" x2="6" y2="32" stroke="#f97316" strokeWidth="1.5" opacity="0.3"/><line x1="20" y1="20" x2="28" y2="38" stroke="#f97316" strokeWidth="1.5" opacity="0.25"/><circle cx="8" cy="8" r="2.5" fill="#f97316" opacity="0.6"/><circle cx="34" cy="6" r="2" fill="#f97316" opacity="0.5"/><circle cx="36" cy="28" r="1.8" fill="#f97316" opacity="0.4"/><circle cx="6" cy="32" r="2" fill="#f97316" opacity="0.45"/><circle cx="28" cy="38" r="1.5" fill="#f97316" opacity="0.35"/><circle cx="20" cy="20" r="5" fill="url(#lgGlow)" filter="url(#lgGl)"/><circle cx="20" cy="20" r="2.5" fill="#0b0b14"/><circle cx="20" cy="20" r="1.2" fill="#f97316"/></g><text x="60" y="44" fontFamily="'Chakra Petch',system-ui,sans-serif" fontWeight="700" fontSize="36" letterSpacing="0.18em" fill="url(#lgText)">FRACMAP</text><rect x="62" y="50" width="48" height="1.5" rx="0.75" fill="#f97316" opacity="0.7"/></svg>
          </a>
          <a href="/" className="text-xs text-brand hover:text-white transition-colors">← Back to dashboard</a>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-white mb-1">Privacy Policy</h1>
        <p className="text-sm text-white/40 mb-8">Last updated: 10 February 2026</p>

        <div className="space-y-8 text-sm text-white/70 leading-relaxed">
          <p>
            fracmap (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) respects your privacy and is committed to protecting your personal data. This Privacy Policy explains how we collect, use, and safeguard information when you use{" "}
            <a href="https://fracmap.com" className="text-brand hover:underline">https://fracmap.com</a> (the &ldquo;Website&rdquo;).
          </p>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">1. Who we are</h2>
            <p>
              fracmap<br />
              13 Old Rectory Close<br />
              Instow, Devon EX39 4LY<br />
              United Kingdom
            </p>
            <p className="mt-2">If you have questions about this policy, contact us at{" "}
              <a href="mailto:support@fracmap.com" className="text-brand hover:underline">support@fracmap.com</a>.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">2. Information we collect</h2>
            <p>We collect only the minimum data required to operate the service:</p>

            <h3 className="text-sm font-semibold text-white/90 mt-4 mb-1">Account information</h3>
            <p>When you register using Twitter (X) OAuth, we may receive:</p>
            <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
              <li>Your Twitter/X user ID</li>
              <li>Display name</li>
              <li>Username</li>
              <li>Profile image (if provided by Twitter)</li>
            </ul>

            <h3 className="text-sm font-semibold text-white/90 mt-4 mb-1">Usage data</h3>
            <p>Basic technical data such as IP address, browser type, device information, and pages visited, used for security and performance monitoring.</p>
            <p className="mt-2">We do not collect passwords when you sign in with Twitter/X.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">3. How we use your data</h2>
            <p>We use your data to:</p>
            <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
              <li>Create and manage your fracmap account</li>
              <li>Authenticate you via Twitter/X OAuth</li>
              <li>Operate, maintain, and improve the Website</li>
              <li>Prevent fraud and abuse</li>
              <li>Comply with legal obligations</li>
            </ul>
            <p className="mt-2 font-semibold text-white/90">We do not sell your personal data.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">4. Legal basis for processing (UK &amp; EU GDPR)</h2>
            <p>We process personal data under the following lawful bases:</p>
            <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
              <li><span className="text-white/90 font-medium">Contract</span> — to provide the service you request</li>
              <li><span className="text-white/90 font-medium">Legitimate interests</span> — to operate and secure the Website</li>
              <li><span className="text-white/90 font-medium">Consent</span> — where required (e.g. optional cookies)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">5. Cookies</h2>
            <p>We use essential cookies only, required for authentication and basic site functionality. We do not use advertising or tracking cookies.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">6. Data sharing</h2>
            <p>We may share limited data with:</p>
            <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
              <li><span className="text-white/90 font-medium">Twitter/X</span> — for OAuth authentication</li>
              <li><span className="text-white/90 font-medium">Infrastructure providers</span> (e.g. hosting, databases) strictly to run the service</li>
            </ul>
            <p className="mt-2">All providers are required to protect your data.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">7. International data transfers</h2>
            <p>Some service providers may process data outside the UK or EU. Where this happens, we ensure appropriate safeguards are in place, such as standard contractual clauses or equivalent protections.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">8. Data retention</h2>
            <p>We retain personal data only for as long as your account remains active or as required by law. You may request account deletion at any time.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">9. Your rights</h2>
            <p>Under UK GDPR and EU GDPR, you have the right to:</p>
            <ul className="list-disc list-inside ml-2 mt-1 space-y-0.5">
              <li>Access your personal data</li>
              <li>Request correction or deletion</li>
              <li>Object to or restrict processing</li>
              <li>Data portability</li>
              <li>Lodge a complaint with the UK Information Commissioner&rsquo;s Office (ICO)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">10. Security</h2>
            <p>We take reasonable technical and organisational measures to protect your data from loss, misuse, or unauthorised access.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-white mb-2">11. Changes to this policy</h2>
            <p>We may update this Privacy Policy from time to time. The latest version will always be available on this page.</p>
          </section>

          <section className="border-t border-white/10 pt-8">
            <h2 className="text-base font-semibold text-white mb-2">Manage your account</h2>
            <p>To delete your account, unsubscribe from communications, or request a copy of your data, use the link below or email us at{" "}
              <a href="mailto:support@fracmap.com" className="text-brand hover:underline">support@fracmap.com</a>.
            </p>
            <a href="/unsubscribe" className="inline-block mt-3 px-4 py-2 text-xs font-semibold rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors">
              Unsubscribe / Delete Account
            </a>
          </section>
        </div>
      </main>

      <footer className="text-center py-6 text-white/20 text-[11px] border-t border-line mt-10">
        FRACMAP · AI Market Desk
      </footer>
    </div>
  );
}
