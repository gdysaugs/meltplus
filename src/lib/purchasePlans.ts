export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'starter', label: 'Starter', price: 550, tickets: 30, priceId: 'price_1TEr9NAVfITDQlasv8ihyh8x' },
  { id: 'basic', label: 'Basic', price: 1440, tickets: 80, priceId: 'price_1TEr9bAVfITDQlaslyNuz3SC' },
  { id: 'standard', label: 'Standard', price: 2800, tickets: 160, priceId: 'price_1TEr9pAVfITDQlasrgQspVXr' },
  { id: 'plus', label: 'Plus', price: 4760, tickets: 280, priceId: 'price_1TErAKAVfITDQlasTRAEkoHO' },
  { id: 'pro', label: 'Pro', price: 8250, tickets: 500, priceId: 'price_1TErAaAVfITDQlasH5ggQot9' },
  { id: 'ultra', label: 'Ultra', price: 16000, tickets: 1000, priceId: 'price_1TErApAVfITDQlas4PgUgN6i' },
]
