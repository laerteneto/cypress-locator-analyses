Cypress.Commands.add('getBySel', (selector: string, ...args: any[]) => cy.get(`[data-cy=${selector}]`, ...args));

Cypress.Commands.add('getByClass', (cls: string) => {
  return cy.get(`.${cls}`);
});

Cypress.Commands.add('login', (email: string, password: string) => {
  cy.get('#email').type(email);
  cy.get('input[type=password]').type(password);
  cy.get('form > div:nth-child(3) > button').click();
});

Cypress.Commands.add('clickRow', { prevSubject: 'element' }, (subject: any, index: number) => {
  cy.wrap(subject).find('tr').eq(index).click();
});
