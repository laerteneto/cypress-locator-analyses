export class LoginPage {
  visit() {
    cy.visit('/login');
  }

  login(email: string, password: string) {
    cy.findByLabelText('Email').type(email);
    cy.findByLabelText('Password').type(password);
    cy.findByRole('button', { name: 'Sign in' }).click();
  }
}
