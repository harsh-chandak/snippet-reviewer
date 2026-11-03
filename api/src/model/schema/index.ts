import Snippet from './Snippet';
import Review from './Review';
import Finding from './Finding';

// All associations in one place, so every model is loaded before db.sync() runs.
Snippet.hasMany(Review, { foreignKey: { name: 'snippetId', allowNull: false }, as: 'reviews', onDelete: 'CASCADE' });
Review.belongsTo(Snippet, { foreignKey: 'snippetId', as: 'snippet' });

Review.hasMany(Finding, { foreignKey: { name: 'reviewId', allowNull: false }, as: 'findings', onDelete: 'CASCADE' });
Finding.belongsTo(Review, { foreignKey: 'reviewId', as: 'review' });

export { Snippet, Review, Finding };
