const User = require('../models/user');
const Task = require('../models/task');

module.exports = function (router) {
    function ok(res, data, message) {
        res.status(200).json({ message: message || 'OK', data: data });
    }
    function created(res, data, message) {
        res.status(201).json({ message: message || 'Created', data: data });
    }
    function notFound(res, what) {
        res.status(404).json({ message: (what || 'Resource') + ' not found', data: null });
    }
    function badRequest(res, msg) {
        res.status(400).json({ message: msg || 'Bad Request', data: null });
    }
    function serverError(res) {
        res.status(500).json({ message: 'Server error', data: null });
    }
    function parseJSONParam(res, value, name) {
        if (value === undefined) return undefined;
        try { return JSON.parse(value); }
        catch (e) {
            badRequest(res, "Invalid JSON in '" + name + "' parameter");
            return null;
        }
    }
    function toBool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') return v.toLowerCase() === 'true';
        return false;
    }

    async function addPendingToUser(userId, taskId) {
        if (!userId) return;
        await User.findByIdAndUpdate(userId, { $addToSet: { pendingTasks: String(taskId) } }).exec();
    }
    async function removePendingFromUser(userId, taskId) {
        if (!userId) return;
        await User.findByIdAndUpdate(userId, { $pull: { pendingTasks: String(taskId) } }).exec();
    }

    // GET /users and POST /users
    router.route('/users')
        .get(async (req, res) => {
            try {
                const where = parseJSONParam(res, req.query.where, 'where'); if (where === null) return;
                const sort = parseJSONParam(res, req.query.sort, 'sort'); if (sort === null) return;
                const select = parseJSONParam(res, req.query.select, 'select'); if (select === null) return;
                const skip = req.query.skip ? parseInt(req.query.skip, 10) : undefined;
                const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
                const count = toBool(req.query.count);

                if (count) {
                    const c = await User.countDocuments(where || {}).exec();
                    return ok(res, c);
                }

                let q = User.find(where || {});
                if (sort) q = q.sort(sort);
                if (select) q = q.select(select);
                if (typeof skip === 'number' && !isNaN(skip)) q = q.skip(skip);
                if (typeof limit === 'number' && !isNaN(limit)) q = q.limit(limit);

                const users = await q.exec();
                return ok(res, users);
            } catch (e) {
                return serverError(res);
            }
        })
        .post(async (req, res) => {
            try {
                const body = req.body || {};
                const name = (body.name || '').trim();
                const email = (body.email || '').trim().toLowerCase();
                if (!name || !email) return badRequest(res, 'User must have name and email');

                // unique email check
                const existing = await User.findOne({ email }).exec();
                if (existing) return badRequest(res, 'A user with this email already exists');

                const pendingTasks = Array.isArray(body.pendingTasks) ? body.pendingTasks.map(String) : [];

                const user = new User({
                    name,
                    email,
                    pendingTasks: []
                });
                await user.save();

                // If pendingTasks provided, assign those tasks to this user
                if (pendingTasks.length > 0) {
                    // Assign each task; adjust other users if necessary
                    const tasks = await Task.find({ _id: { $in: pendingTasks } }).exec();
                    await Promise.all(tasks.map(async (t) => {
                        if (t.assignedUser && t.assignedUser !== String(user._id)) {
                            await removePendingFromUser(t.assignedUser, t._id);
                        }
                        t.assignedUser = String(user._id);
                        t.assignedUserName = user.name;
                        await t.save();
                        if (!t.completed) {
                            await addPendingToUser(user._id, t._id);
                        } else {
                            await removePendingFromUser(user._id, t._id);
                        }
                    }));
                }

                const freshUser = await User.findById(user._id).exec();
                return created(res, freshUser);
            } catch (e) {
                if (e && e.code === 11000) {
                    return badRequest(res, 'A user with this email already exists');
                }
                return serverError(res);
            }
        });

    // /users/:id
    router.route('/users/:id')
        .get(async (req, res) => {
            try {
                const select = parseJSONParam(res, req.query.select, 'select'); if (select === null) return;
                let q = User.findById(req.params.id);
                if (select) q = q.select(select);
                const user = await q.exec();
                if (!user) return notFound(res, 'User');
                return ok(res, user);
            } catch (e) {
                // return badRequest(res, 'Invalid user id');
                return notFound(res, 'User');
            }
        })
        .put(async (req, res) => {
            try {
                const body = req.body || {};
                const name = (body.name || '').trim();
                const email = (body.email || '').trim().toLowerCase();
                if (!name || !email) return badRequest(res, 'User must have name and email');

                const user = await User.findById(req.params.id).exec();
                if (!user) return notFound(res, 'User');

                // email uniqueness
                const dupe = await User.findOne({ email }).exec();
                if (dupe && String(dupe._id) !== String(user._id)) {
                    return badRequest(res, 'A user with this email already exists');
                }

                const newPending = Array.isArray(body.pendingTasks) ? body.pendingTasks.map(String) : [];

                const prevPending = (user.pendingTasks || []).map(String);
                const toRemove = prevPending.filter(id => !newPending.includes(id));
                const toAdd = newPending.filter(id => !prevPending.includes(id));

                // Unassign tasks removed from pending
                if (toRemove.length > 0) {
                    const removedTasks = await Task.find({ _id: { $in: toRemove } }).exec();
                    await Promise.all(removedTasks.map(async (t) => {
                        t.assignedUser = "";
                        t.assignedUserName = "unassigned";
                        await t.save();
                        await removePendingFromUser(user._id, t._id);
                    }));
                }

                // Assign tasks added to pending (and pull from other users if necessary)
                if (toAdd.length > 0) {
                    const addedTasks = await Task.find({ _id: { $in: toAdd } }).exec();
                    await Promise.all(addedTasks.map(async (t) => {
                        if (t.assignedUser && t.assignedUser !== String(user._id)) {
                            await removePendingFromUser(t.assignedUser, t._id);
                        }
                        t.assignedUser = String(user._id);
                        t.assignedUserName = name;
                        await t.save();
                        if (!t.completed) {
                            await addPendingToUser(user._id, t._id);
                        } else {
                            await removePendingFromUser(user._id, t._id);
                        }
                    }));
                }

                // Update user fields
                user.name = name;
                user.email = email;
                user.pendingTasks = newPending;
                await user.save();

                const freshUser = await User.findById(user._id).exec();
                return ok(res, freshUser);
            } catch (e) {
                if (e && e.code === 11000) {
                    return badRequest(res, 'A user with this email already exists');
                }
                return serverError(res);
            }
        })
        .delete(async (req, res) => {
            try {
                const user = await User.findById(req.params.id).exec();
                if (!user) return notFound(res, 'User');

                const pending = (user.pendingTasks || []).map(String);
                if (pending.length > 0) {
                    const tasks = await Task.find({ _id: { $in: pending } }).exec();
                    await Promise.all(tasks.map(async (t) => {
                        t.assignedUser = "";
                        t.assignedUserName = "unassigned";
                        await t.save();
                    }));
                }

                await User.deleteOne({ _id: user._id }).exec();
                return res.status(200).json({ message: 'User deleted', data: {} });
            } catch (e) {
                return serverError(res);
            }
        });

    return router;
};