class LoginPage {
  constructor() {
    this.emailInput = '#email';
  }

  elements = {
    submit: () => cy.get('form .btn-primary'),
  };

  typeEmail(email) {
    cy.get(this.emailInput).type(email);
  }

  submit() {
    this.elements.submit().click();
  }
}

export default new LoginPage();
