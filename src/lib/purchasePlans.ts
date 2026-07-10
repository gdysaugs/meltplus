export type PurchasePlan = {
  id: string
  label: string
  price: number
  tickets: number
  priceId: string
}

export const PURCHASE_PLANS: PurchasePlan[] = [
  { id: 'starter', label: 'Starter', price: 550, tickets: 30, priceId: 'price_1TrWsyA2idukkEyjbpc6MHlb' },
  { id: 'basic', label: 'Basic', price: 1440, tickets: 80, priceId: 'price_1TrWtAA2idukkEyjsOqXrOaZ' },
  { id: 'standard', label: 'Standard', price: 2800, tickets: 160, priceId: 'price_1TrWtSA2idukkEyjpZRjdHeR' },
  { id: 'plus', label: 'Plus', price: 4760, tickets: 280, priceId: 'price_1TrWwJA2idukkEyjZZ8fLVk7' },
  { id: 'pro', label: 'Pro', price: 8250, tickets: 500, priceId: 'price_1TrWwZA2idukkEyjAry8u0Ku' },
  { id: 'ultra', label: 'Ultra', price: 16000, tickets: 1000, priceId: 'price_1TrWwoA2idukkEyjEs8qkFLY' },
]
