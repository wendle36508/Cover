## Recommended Connect integration

Made with Stripe's Connect guide on Nov 13, 2026 for Cover: nonprofits get a sponsor page; donors give a fixed monthly gift inside Cover's pop-up; money goes to the nonprofit.

### A. Account configuration
Accounts API: `/v2/core/accounts`
Legacy account `type`: not used
Dashboard: express
Fee collection: Stripe
Negative balance liability: Stripe

Each nonprofit is a small, self-serve organization that's mostly new to Stripe, so a lightweight Express dashboard fits better than a full Stripe account. Stripe-managed pricing means Stripe bills processing fees to the nonprofit (so any nonprofit discount Stripe gives applies to them), and Stripe-managed negative balance liability keeps chargeback losses off a solo founder's platform.

Each connected account needs merchant configuration (`configuration.merchant`) for direct charges.

**Public preview:** Express dashboard with Stripe-managed negative balance liability on direct charges is in public preview. It requires the current Connect preview API version rather than a pinned stable version (confirm it in the [preview changelog](https://docs.stripe.com/changelog.md?preview=true)), and it only works for newly onboarded connected accounts. The dashboard choice is permanent for each account.

### B. Charge pattern: direct charges
The nonprofit is the merchant of record: its name appears on the donor's card statement, it issues the tax receipt, and the gift is its revenue. Direct charges create each monthly subscription on the nonprofit's own connected account, so money settles to the nonprofit and Cover never holds funds.

### C. Nonprofit onboarding flow
Onboarding method: embedded
Embedded onboarding keeps the nonprofit inside Cover (no hand-off to a separate Stripe site), which matters for small teams who'd otherwise drop off.

1. Nonprofit signs up in Cover.
2. Cover's server creates a v2 connected account (Express dashboard, Stripe fees and losses, merchant configuration with `card_payments` requested).
3. Nonprofit completes embedded `account_onboarding` (legal name, EIN, bank account, a representative's identity).
4. Stripe verifies the details.
5. Cover checks capability status (section G) before turning on the nonprofit's sponsor page.
6. `notification_banner` and ongoing status checks keep the account enabled as Stripe's requirements change.

### D. Payments dashboard access for nonprofits
**Decision (Tanner, Nov 13, 2026): nonprofits manage everything from a dashboard inside Cover.** Cover's nonprofit dashboard is built from Stripe's embedded components (section E), so nonprofits see gifts, payouts, refunds, disputes and bank details without leaving Cover. The Express dashboard still exists behind the scenes as Stripe's backup; Cover only generates an Express login link as a fallback (for example, if Stripe support asks a nonprofit to use it). Nonprofits still pay Stripe's processing fees, and Stripe still carries negative balance liability.

### E. Embedded components
Recommended [Connect embedded components](https://docs.stripe.com/connect/supported-embedded-components), all shown inside Cover's nonprofit dashboard:
- `account_onboarding`
- `notification_banner` (required; keeps nonprofits aware of new requirements so they stay enabled)
- `account_management` (bank account, business details)
- `payments` (every gift, refunds and disputes; direct charges show full detail)
- `payouts` (money sent to the nonprofit's bank)

### F. Webhook integration
Use webhooks for reliable payment confirmation, especially for async payment methods, and always verify incoming webhook signatures before processing event data ([webhook signature verification](https://stripe.com/docs/events/manage-webhook-endpoints#signature-errors)); specific events and implementation details are covered in the build step.

### G. Onboarding status gating
Verify capability statuses with `stripe.v2.core.accounts.retrieve(id)` before showing a nonprofit's Sponsor buttons:
- `configuration.merchant.capabilities.card_payments.status === 'active'`
- `configuration.merchant.capabilities.stripe_balance.payouts.status === 'active'`

### H. Fee structure
- Platform fee model: none during the pilot; a percentage fee per gift may be added later.
- `application_fee_amount` strategy: platform fee only (`platform_fee_only`). With direct charges and Stripe-managed pricing, the nonprofit pays Stripe's processing fees directly, so any fee Cover adds is kept in full and doesn't need to cover Stripe's cut. For subscriptions, this is set as `application_fee_percent`.
- Donors pay the nonprofit. Stripe deducts its processing fees from the nonprofit's balance. Nothing is transferred from Cover. Rates vary by card and method; check [stripe.com/pricing](https://stripe.com/pricing).

```
   Donor pays $25 / month
          │
          ▼
  ┌────────────────────────┐
  │  Nonprofit (Stripe     │ ─── pays Stripe's processing fee
  │  connected account)    │
  └──────────┬─────────────┘
             │ application fee (later, e.g. X%)
             ▼
  ┌────────────────────────┐
  │  Cover (platform)      │ ─── keeps X% in full
  └────────────────────────┘
  Nonprofit receives $25 minus Stripe's fee minus X%, paid out to its bank.
```

### I. SaaS monetization
Pilot: no fees. Later choice: a transaction fee (`application_fee_percent` on each subscription) or a flat monthly software fee billed to the nonprofit. If Cover ever bills nonprofits a monthly fee, the connected account also gets a `customer` configuration and is passed as `customer_account` (no separate v1 Customer object).

### J. Implementation plan
1. **Account setup:** create Cover's platform profile in the Stripe Dashboard, turn on Radar for Platforms, pin the preview API version for Connect calls.
2. **Onboarding:** Supabase Edge Function to create v2 accounts and account sessions; embedded `account_onboarding` on a nonprofit admin page.
3. **Payments:** Edge Function that creates an embedded Checkout Session in subscription mode on the nonprofit's connected account (direct charge) for the chosen monthly price; mount it inside Cover's sponsor pop-up.
4. **Webhooks and gating:** signed webhook endpoint (Edge Function) that marks sponsors active or canceled in the database; capability checks before a nonprofit's page goes live.
5. **Go-live:** test the full flow with test cards, then switch keys to live, confirm the nonprofit's account is fully verified, and check state charitable-solicitation registration rules for platforms.

### K. Risk and liability

#### Negative balance liability
Owner: Stripe. If a donor disputes a gift and the nonprofit's balance goes negative, Stripe recovers it from the nonprofit (`losses_collector: "stripe"` turns on Stripe's Managed Risk product: loss protection, risk monitoring and negative-balance recovery). Cover isn't on the hook.

#### Risk management
Owner: Stripe. Turn on Radar for Platforms; Managed Risk's loss protection assumes Radar is active to catch fraudulent cards, so it isn't optional here.

### L. Why this fits your business
- Nonprofits are the merchant of record and issue tax receipts, which is exactly what direct charges model.
- Small nonprofits new to Stripe need the lightest possible setup: Express dashboard plus onboarding inside Cover.
- A solo founder shouldn't carry chargeback losses or Stripe fee risk; Stripe-managed pricing and liability remove both.
- Cover can add revenue later with an application fee without restructuring.

### M. Open questions
- Exact preview API version to pin (check the preview changelog when building).
- Whether Cover adds a per-gift fee or a monthly fee to nonprofits, and when.
- Charitable-solicitation registration requirements for a donation platform in the states where pilots run.
- Whether donors can choose amounts other than the nonprofit's fixed monthly price.
