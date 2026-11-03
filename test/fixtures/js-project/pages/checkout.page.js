class CheckoutPage {
  constructor() {
    this.payButton = '.css-1x2y3z';
  }

  pay() {
    cy.get(this.payButton).click();
  }
}

export default new CheckoutPage();
