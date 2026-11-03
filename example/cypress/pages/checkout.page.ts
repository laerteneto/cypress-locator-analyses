export class CheckoutPage {
  readonly couponInput = '#coupon-input-8f3k2a';
  readonly applyButton = 'div.CheckoutForm_actions__x7Ka2 > button:nth-child(2)';

  get total() {
    return cy.xpath('//html/body/div[1]/main/section[2]/div/span[3]');
  }

  get items() {
    return cy.get('.cart-item');
  }

  itemRow(name: string) {
    return cy.findByRole('row', { name });
  }

  applyCoupon(code: string) {
    cy.get(this.couponInput).type(code);
    cy.get(this.applyButton).click();
  }
}
