describe('Profile', () => {
  beforeEach(() => {
    cy.visit('/profile');
    cy.get('.css-1x2y3z').click(); // dismiss the cookie banner
  });

  it('updates the name', () => {
    cy.getBySel('profile-name').clear().type('Ana');
    cy.findByRole('button', { name: 'Save' }).click();
    cy.findByRole('status').should('have.text', 'Saved!');
  });

  it('changes the avatar', () => {
    cy.getBySel('avatar-upload').selectFile('avatar.png');
    cy.findByAltText('Avatar').should('be.visible');
  });
});
