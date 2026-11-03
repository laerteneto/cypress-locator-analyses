const RESULTS = '.search-results';

it('searches for a product', () => {
  cy.visit('/');
  cy.get('input.mt-4.px-2.rounded-lg').type('sneakers');
  cy.get('button.sc-bdVaJa').click();
  cy.get(`${RESULTS} > li`).first().should('be.visible');
});

it('filters by category', () => {
  cy.findByRole('combobox', { name: 'Category' }).select('Shoes');
  cy.contains('Only show products with free shipping to anywhere in the country').click();
  cy.get('ul[data-cy="results"] li:nth-of-type(3)').should('be.visible');
});

it('opens details through an XPath', () => {
  cy.xpath("//div[@class='product-card'][2]/following-sibling::div//a").click();
  // cypress-locator-analyses-ignore
  cy.get('#legacy-widget-12345').click();
});
