import type { Metadata } from 'next';

import './globals.css';
import { AppHeader } from '@/components/AppHeader';
import { WalletPicker } from '@/components/WalletPicker';
import { WalletProvider } from '@/lib/wallet';

export const metadata: Metadata = {
  title: 'Recourse',
  description:
    'A promise locked in writing, checked against what actually arrived. ' +
    'Payment is held in escrow on Base until the promise is kept or a refund is decided.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <WalletProvider>
          <AppHeader />
          {/* Rendered here rather than inside the header because it is a
              full-screen overlay, and it reads its own state from the wallet
              context — the header only triggers it. */}
          <WalletPicker />
          <main className="flex-1 py-8">{children}</main>
          <footer className="doc-rule mt-8">
            <div className="sheet flex flex-col gap-2 py-6 text-[12px] text-ink-muted">
              <p className="max-w-measure">
                Base Sepolia testnet. No real funds are involved anywhere in this build. The
                relayer that carries a finding from GenLayer to Base is a trusted prototype
                component, not a trustless bridge.
              </p>
              <p className="max-w-measure">
                Wallet addresses are not identity checks — one person can hold many, and several
                people can share one. Nothing here is a reputation score.
              </p>
            </div>
            {/* The other half of the page frame, matching the band at the top of
                the header. Once per page, never per card. */}
            <div className="security-band" />
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
