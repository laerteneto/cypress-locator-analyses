beforeEach(() => {
  cy.visit('cypress/fixtures/shop.html');
});

it('submits the form with robust locators', () => {
  cy.findByLabelText('Email').type('ana@example.com');
  cy.get('[data-cy=submit]').click();
  cy.findByRole('button', { name: 'Send' }).should('be.visible');
});

it('reads a result by position', () => {
  cy.get('.css-1x2y3z').click();
  cy.get('ul.results > li:nth-child(2)').should('have.text', 'Banana');
});

it('reads results through an alias', () => {
  cy.get('ul.results li').as('fruits');
  cy.get('@fruits').eq(0).should('have.text', 'Apple');
});

// Fails on the first attempt on purpose and passes on retry,
// so the plugin must mark it as flaky.
it('is flaky on the first attempt', () => {
  const expected = Cypress.currentRetry === 0 ? 'Not cherry' : 'Cherry';
  cy.get('body > ul > li:eq(2)', { timeout: 500 }).should('have.text', expected);
});
