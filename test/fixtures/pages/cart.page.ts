export const SELECTORS = { promo: '.promo-banner' } as const;

export class CartPage {
  readonly checkoutButton: string;

  constructor() {
    this.checkoutButton = '#app > div:nth-child(2) button.Cart_cta__a9F3k';
  }

  get list() {
    return cy.get('[data-cy=cart-list]');
  }

  get firstItem() {
    return this.list.findByRole('listitem').first();
  }

  checkout() {
    cy.get(this.checkoutButton).click();
  }

  closePromo() {
    cy.get(SELECTORS.promo).click();
  }
}
