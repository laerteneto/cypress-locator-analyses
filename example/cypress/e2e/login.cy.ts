import { LoginPage } from '../pages/login.page';

describe('Login', () => {
  it('signs in with valid credentials', () => {
    const login = new LoginPage();
    login.visit();
    login.login('ana@example.com', 's3cr3t');
    cy.getBySel('user-menu').should('be.visible');
  });

  it('shows an error for a wrong password', () => {
    const login = new LoginPage();
    login.login('ana@example.com', 'wrong');
    cy.findByRole('alert').should('contain.text', 'Invalid password');
  });
});
