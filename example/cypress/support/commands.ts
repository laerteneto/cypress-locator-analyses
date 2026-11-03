declare global {
  namespace Cypress {
    interface Chainable {
      /** Gets an element by its data-cy attribute. */
      getBySel(selector: string): Chainable<JQuery<HTMLElement>>;
      /** Provided by an XPath plugin (cypress-xpath / @cypress/xpath). */
      xpath(selector: string): Chainable<JQuery<HTMLElement>>;
    }
  }
}

Cypress.Commands.add('getBySel', (selector: string) => cy.get(`[data-cy=${selector}]`));

export {};
