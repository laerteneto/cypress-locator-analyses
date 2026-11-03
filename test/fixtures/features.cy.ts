describe('Cypress features', () => {
  it('custom query commands', () => {
    cy.getBySel('save').click();
    cy.getByClass('css-1x2y3z').click();
  });

  it('custom command with steps', () => {
    cy.login('ana@example.com', 's3cr3t');
  });

  it('alias', () => {
    cy.get('ul.results > li').as('rows');
    cy.get('@rows').eq(2).should('be.visible');
  });

  it('within', () => {
    cy.get('[data-cy=login-form]').within(() => {
      cy.get('input').first().type('ana');
      cy.contains('Sign in').click();
    });
  });

  it('traversal', () => {
    cy.contains('Total').parent().siblings('.amount').should('have.text', '$9');
  });

  it('child command', () => {
    cy.get('[data-cy=orders]').clickRow(1);
  });

  it('jquery pseudos and contains with selector', () => {
    cy.get('li:first').click();
    cy.contains('button', 'Delete').click();
  });

  it('testing library', () => {
    cy.findByLabelText('Email').type('ana');
    cy.findAllByRole('row').eq(1).should('exist');
  });

  it('ignores non-cypress chains', () => {
    const users = [{ id: 1 }];
    users.find((u) => u.id === 1);
    new Map<string, string>().get('x');
    cy.intercept('/api/users').as('users');
    cy.wait('@users');
    cy.get('@users').its('response.statusCode').should('eq', 200);
  });

  it('chain continues after an action', () => {
    cy.get('[data-cy=menu]').click().find('a.css-1x2y3z').click();
  });
});
