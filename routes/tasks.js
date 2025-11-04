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

    // GET /tasks and POST /tasks
    router.route('/tasks')
        .get(async (req, res) => {
            try {
                const where = parseJSONParam(res, req.query.where, 'where'); if (where === null) return;
                const sort = parseJSONParam(res, req.query.sort, 'sort'); if (sort === null) return;
                const select = parseJSONParam(res, req.query.select, 'select'); if (select === null) return;
                const skip = req.query.skip ? parseInt(req.query.skip, 10) : undefined;
                let limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
                const count = toBool(req.query.count);

                if (!count && (limit === undefined || isNaN(limit))) {
                    limit = 100;
                }

                if (count) {
                    const c = await Task.countDocuments(where || {}).exec();
                    return ok(res, c);
                }

                let q = Task.find(where || {});
                if (sort) q = q.sort(sort);
                if (select) q = q.select(select);
                if (typeof skip === 'number' && !isNaN(skip)) q = q.skip(skip);
                if (typeof limit === 'number' && !isNaN(limit)) q = q.limit(limit);

                const tasks = await q.exec();
                return ok(res, tasks);
            } catch (e) {
                return serverError(res);
            }
        })
        .post(async (req, res) => {
            try {
                const body = req.body || {};
                const name = (body.name || '').trim();
                const deadline = body.deadline ? new Date(body.deadline) : null;
                if (!name || !deadline || isNaN(deadline.getTime())) {
                    return badRequest(res, 'Task must have a valid name and deadline');
                }

                const description = body.description ? String(body.description) : "";
                const completed = typeof body.completed === 'boolean' ? body.completed : false;
                let assignedUser = body.assignedUser ? String(body.assignedUser) : "";
                let assignedUserName = "unassigned";

                if (assignedUser) {
                    const user = await User.findById(assignedUser).exec();
                    if (!user) return badRequest(res, 'Assigned user does not exist');
                    assignedUserName = user.name;
                }

                const task = new Task({
                    name,
                    description,
                    deadline,
                    completed,
                    assignedUser,
                    assignedUserName
                });
                await task.save();

                if (assignedUser) {
                    if (!completed) {
                        await addPendingToUser(assignedUser, task._id);
                    } else {
                        await removePendingFromUser(assignedUser, task._id);
                    }
                }

                const freshTask = await Task.findById(task._id).exec();
                return created(res, freshTask);
            } catch (e) {
                return serverError(res);
            }
        });

    router.route('/tasks/:id')
        .get(async (req, res) => {
            try {
                const select = parseJSONParam(res, req.query.select, 'select'); if (select === null) return;
                let q = Task.findById(req.params.id);
                if (select) q = q.select(select);
                const task = await q.exec();
                if (!task) return notFound(res, 'Task');
                return ok(res, task);
            } catch (e) {
                return badRequest(res, 'Invalid task id');
            }
        })
        .put(async (req, res) => {
            try {
                const body = req.body || {};
                const name = (body.name || '').trim();
                const deadline = body.deadline ? new Date(body.deadline) : null;
                if (!name || !deadline || isNaN(deadline.getTime())) {
                    return badRequest(res, 'Task must have a valid name and deadline');
                }

                const task = await Task.findById(req.params.id).exec();
                if (!task) return notFound(res, 'Task');

                const prevAssignedUser = task.assignedUser || "";
                const prevCompleted = !!task.completed;

                task.name = name;
                task.description = body.description ? String(body.description) : "";
                task.deadline = deadline;
                task.completed = typeof body.completed === 'boolean' ? body.completed : false;

                let newAssignedUser = body.assignedUser ? String(body.assignedUser) : "";
                if (newAssignedUser) {
                    const user = await User.findById(newAssignedUser).exec();
                    if (!user) return badRequest(res, 'Assigned user does not exist');
                    task.assignedUser = String(user._id);
                    task.assignedUserName = user.name;
                } else {
                    task.assignedUser = "";
                    task.assignedUserName = "unassigned";
                }

                await task.save();

                const newCompleted = !!task.completed;
                newAssignedUser = task.assignedUser || "";

                if (prevAssignedUser && prevAssignedUser !== newAssignedUser) {
                    await removePendingFromUser(prevAssignedUser, task._id);
                }

                if (newAssignedUser) {
                    if (!newCompleted) {
                        await addPendingToUser(newAssignedUser, task._id);
                    } else {
                        await removePendingFromUser(newAssignedUser, task._id);
                    }
                }

                if (prevAssignedUser && prevAssignedUser === newAssignedUser) {
                    if (!prevCompleted && newCompleted) {
                        await removePendingFromUser(newAssignedUser, task._id);
                    } else if (prevCompleted && !newCompleted) {
                        await addPendingToUser(newAssignedUser, task._id);
                    }
                }

                const freshTask = await Task.findById(task._id).exec();
                return ok(res, freshTask);
            } catch (e) {
                return serverError(res);
            }
        })
        .delete(async (req, res) => {
            try {
                const task = await Task.findById(req.params.id).exec();
                if (!task) return notFound(res, 'Task');

                const assignedUser = task.assignedUser || "";
                await Task.deleteOne({ _id: task._id }).exec();

                if (assignedUser) {
                    await removePendingFromUser(assignedUser, task._id);
                }

                return res.status(200).json({ message: 'Task deleted', data: {} });
            } catch (e) {
                return serverError(res);
            }
        });

    return router;
};
