import { CartPage } from './pages/cart.page';

describe('Cart', () => {
  beforeEach(() => {
    cy.xpath('/html/body/div[3]/button').click();
  });

  it('checkout via page object', () => {
    const cart = new CartPage();
    cart.checkout();
  });

  it('robust test', () => {
    cy.findByRole('button', { name: 'Buy' }).click();
  });

  context('nested', () => {
    it('uses getter and constant', () => {
      const cart = new CartPage();
      cart.firstItem.should('be.visible');
      cart.closePromo();
      cy.get('.btn-legacy').click(); // cypress-locator-analyses-ignore
    });
  });
});

it('outside describe has no hook', () => {
  cy.get('[data-cy=ok]').click();
});
