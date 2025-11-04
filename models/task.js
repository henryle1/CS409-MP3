var mongoose = require('mongoose');

var TaskSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    assignedUser: { type: String, default: "" },
    assignedUserName: { type: String, default: "unassigned", trim: true },
    dateCreated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Task', TaskSchema);